// How good is the wait estimate? This replays simulated clinic days through the real domain
// code (the same `apply` the Durable Object runs) and compares the wait each customer was
// shown when they joined with the wait they actually had.
//
// Three estimators run on identical days (same seed, same arrivals, same service times):
//   guess     the host's "minutes per person", never updated
//   learned   learns from every finished service
//   filtered  learns, but drops services during which the line ran empty (production)
//
// The days are deliberately unkind: the host's guess is wrong, there's a rush and a lull,
// service times vary a lot, some people don't show up or leave, and when nobody is waiting
// staff often don't press anything until the next person arrives, which is what makes idle
// time look like service time.
//
//   npm run simulate              # 200 days per scenario
//   npm run simulate -- --days 50

import { DEFAULT_ESTIMATOR, type EstimatorOptions } from "../src/domain/estimate";
import { type QueueState, waitingInOrder } from "../src/domain/model";
import { apply, createQueue } from "../src/domain/queue";
import { queueView } from "../src/domain/views";
import { expectedWait, RANGE_HIGH, RANGE_LOW, withinRange } from "../src/shared/estimate";
import type { Command } from "../src/shared/protocol";

const MINUTE = 60_000;

const STRATEGIES: Record<string, EstimatorOptions> = {
  guess: { alpha: 0, dropIdleSamples: false },
  learned: { alpha: DEFAULT_ESTIMATOR.alpha, dropIdleSamples: false },
  filtered: DEFAULT_ESTIMATOR,
};

interface Scenario {
  name: string;
  counters: number;
  /** What the host typed in. */
  guessMinutes: number;
  /** True mean service time. */
  serviceMinutes: number;
  /** Coefficient of variation of service times. */
  serviceCv: number;
  /** Minutes between arrivals, by hour of the day. */
  arrivalGapByHour: number[];
  noShow: number;
  leave: number;
  /** Chance staff press "Call next" right away when they finish and nobody is waiting. */
  pressWhenEmpty: number;
}

const SCENARIOS: Scenario[] = [
  {
    name: "Clinic, 2 rooms, guess too high (10 min vs 6)",
    counters: 2,
    guessMinutes: 10,
    serviceMinutes: 6,
    serviceCv: 0.6,
    arrivalGapByHour: [2.6, 2.8, 4, 8, 5, 3.2],
    noShow: 0.05,
    leave: 0.03,
    pressWhenEmpty: 0.4,
  },
  {
    name: "Service desk, 3 counters, guess too low (3 min vs 7)",
    counters: 3,
    guessMinutes: 3,
    serviceMinutes: 7,
    serviceCv: 0.5,
    arrivalGapByHour: [2, 2.2, 2.6, 6, 3, 2.4, 3],
    noShow: 0.04,
    leave: 0.05,
    pressWhenEmpty: 0.4,
  },
  {
    name: "Interview day, 4 panels, guess right (20 min)",
    counters: 4,
    guessMinutes: 20,
    serviceMinutes: 20,
    serviceCv: 0.35,
    arrivalGapByHour: [3, 4, 6, 8, 6, 5],
    noShow: 0.08,
    leave: 0.02,
    pressWhenEmpty: 0.6,
  },
];

// ---- a seeded random source, so every strategy sees the same day ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Random {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  uniform(lo = 0, hi = 1): number {
    return lo + (hi - lo) * this.next();
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  exponential(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }
  /** Lognormal with the given mean and coefficient of variation. */
  lognormal(mean: number, cv: number): number {
    const sigma2 = Math.log(1 + cv * cv);
    const mu = Math.log(mean) - sigma2 / 2;
    const z = Math.sqrt(-2 * Math.log(1 - this.next())) * Math.cos(2 * Math.PI * this.next());
    return Math.exp(mu + Math.sqrt(sigma2) * z);
  }
}

// ---- one simulated day ----

interface Prediction {
  predicted: number;
  actual: number;
}

type Event =
  | { at: number; kind: "arrive" }
  | { at: number; kind: "press"; counter: number }
  | { at: number; kind: "finish"; counter: number; ticket: string }
  | { at: number; kind: "no_show"; counter: number; ticket: string }
  | { at: number; kind: "leave"; ticket: string };

function simulateDay(scenario: Scenario, seed: number, estimator: EstimatorOptions): Prediction[] {
  // Separate streams, so a strategy can't shift the randomness the day is built from.
  const arrivals = new Random(seed);
  const services = new Random(seed * 7919 + 1);
  const people = new Random(seed * 104729 + 2);
  const staff = new Random(seed * 1299709 + 3);

  let idCounter = 0;
  const newId = () => `t${++idCounter}`;
  let state: QueueState = createQueue(
    {
      code: "SIM234",
      name: scenario.name,
      counters: Array.from({ length: scenario.counters }, (_, i) => `Counter ${i + 1}`),
      serviceMinutes: scenario.guessMinutes,
      demo: false,
      staffKeyHash: "x",
    },
    0,
    newId,
  );

  const events: Event[] = [];
  const schedule = (event: Event) => {
    events.push(event);
    events.sort((a, b) => a.at - b.at);
  };
  const run = (command: Command, now: number, deviceHash?: string) => {
    const outcome = apply(state, command, { now, newId, deviceHash, estimator });
    if (!outcome.ok) return null;
    state = outcome.state;
    return outcome.result;
  };

  const shown = new Map<string, number>(); // ticket id -> predicted wait (ms)
  const results: Prediction[] = [];
  // Counters waiting for someone to arrive before pressing anything.
  const waitingForArrival = new Set<number>();
  const counterId = (index: number) => state.config.counters[index]!.id;

  const closeAt = scenario.arrivalGapByHour.length * 60 * MINUTE;
  const gapAt = (t: number) => scenario.arrivalGapByHour[Math.floor(t / (60 * MINUTE))] ?? 999;
  schedule({ at: arrivals.exponential(gapAt(0) * MINUTE), kind: "arrive" });
  for (let i = 0; i < scenario.counters; i++) waitingForArrival.add(i);

  let arrivalsSoFar = 0;
  while (events.length > 0) {
    const event = events.shift()!;
    const now = event.at;
    switch (event.kind) {
      case "arrive": {
        arrivalsSoFar += 1;
        const device = `device-${arrivalsSoFar}`;
        const result = run({ type: "join", device }, now, device);
        if (result?.type === "joined") {
          const view = queueView(state, now);
          const position = view.waiting.length;
          shown.set(result.ticket.id, expectedWait(position, view.pace) * 1000);
          if (people.chance(scenario.leave)) {
            schedule({ at: now + people.uniform(5, 40) * MINUTE, kind: "leave", ticket: result.ticket.id });
          }
        }
        // A counter that's been waiting for someone presses "Call next" shortly after they arrive.
        const [first] = waitingForArrival;
        if (first !== undefined) {
          waitingForArrival.delete(first);
          schedule({ at: now + staff.uniform(5, 30) * 1000, kind: "press", counter: first });
        }
        const next = now + arrivals.exponential(gapAt(now) * MINUTE);
        if (next < closeAt) schedule({ at: next, kind: "arrive" });
        break;
      }
      case "press": {
        const counter = state.config.counters[event.counter]!;
        const result = run({ type: "call_next", counterId: counter.id, expectServing: counter.serving }, now);
        if (result?.type !== "called") break;
        if (result.ticket === null) {
          waitingForArrival.add(event.counter);
          break;
        }
        const predicted = shown.get(result.ticket.id);
        const ticket = state.tickets.get(result.ticket.id)!;
        if (predicted !== undefined) results.push({ predicted, actual: now - ticket.joinedAt });
        if (people.chance(scenario.noShow)) {
          schedule({ at: now + 60_000, kind: "no_show", counter: event.counter, ticket: ticket.id });
        } else {
          const service = services.lognormal(scenario.serviceMinutes, scenario.serviceCv) * MINUTE;
          schedule({ at: now + service, kind: "finish", counter: event.counter, ticket: ticket.id });
        }
        break;
      }
      case "finish": {
        if (waitingInOrder(state).length > 0 || staff.chance(scenario.pressWhenEmpty)) {
          schedule({ at: now + staff.uniform(5, 30) * 1000, kind: "press", counter: event.counter });
        } else {
          // Done, but nobody's waiting: staff wait for the next arrival before pressing.
          waitingForArrival.add(event.counter);
        }
        break;
      }
      case "no_show": {
        run({ type: "no_show", ticketId: event.ticket }, now);
        schedule({ at: now + staff.uniform(5, 15) * 1000, kind: "press", counter: event.counter });
        break;
      }
      case "leave": {
        const ticket = state.tickets.get(event.ticket);
        if (ticket?.status === "waiting") run({ type: "leave", ticketId: ticket.id, device: "" }, now, ticket.deviceHash);
        break;
      }
    }
    void counterId;
  }
  return results;
}

// ---- scoring ----

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (index - lo);
}

interface Score {
  people: number;
  medianError: number;
  p90Error: number;
  bias: number;
  inRange: number;
  ratioP10: number;
  ratioP90: number;
}

function score(predictions: Prediction[]): Score {
  const errors = predictions.map((p) => Math.abs(p.actual - p.predicted) / MINUTE).sort((a, b) => a - b);
  const bias = predictions.reduce((sum, p) => sum + (p.predicted - p.actual), 0) / predictions.length / MINUTE;
  // The same test the staff screen's accuracy figure uses.
  const inRange = predictions.filter((p) => withinRange(p.predicted / 1000, p.actual / 1000)).length;
  const ratios = predictions
    .filter((p) => p.predicted >= 5 * MINUTE)
    .map((p) => p.actual / p.predicted)
    .sort((a, b) => a - b);
  return {
    people: predictions.length,
    medianError: quantile(errors, 0.5),
    p90Error: quantile(errors, 0.9),
    bias,
    inRange: inRange / predictions.length,
    ratioP10: quantile(ratios, 0.1),
    ratioP90: quantile(ratios, 0.9),
  };
}

// ---- main ----

const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 200;

const fmt = (n: number, digits = 1) => n.toFixed(digits);

console.log(`Simulated days per scenario: ${DAYS}. Range shown to customers: ${RANGE_LOW}× to ${RANGE_HIGH}× the middle, ±1 min.\n`);
for (const scenario of SCENARIOS) {
  console.log(`### ${scenario.name}\n`);
  console.log("| Estimator | People | Median error | 90th pct error | Bias (shown − real) | Real wait inside the range shown | Real ÷ shown, 10th–90th pct |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const [name, options] of Object.entries(STRATEGIES)) {
    const all: Prediction[] = [];
    for (let day = 1; day <= DAYS; day++) all.push(...simulateDay(scenario, day, options));
    const s = score(all);
    console.log(
      `| ${name} | ${s.people} | ${fmt(s.medianError)} min | ${fmt(s.p90Error)} min | ${s.bias >= 0 ? "+" : ""}${fmt(s.bias)} min | ${fmt(s.inRange * 100, 0)}% | ${fmt(s.ratioP10, 2)}–${fmt(s.ratioP90, 2)} |`,
    );
  }
  console.log();
}
