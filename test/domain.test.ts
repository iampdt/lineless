import { describe, expect, it } from "vitest";
import { initialEstimator, pace, recordService, trackLine } from "../src/domain/estimate";
import { expectedWait } from "../src/shared/estimate";
import { waitingInOrder, type QueueState } from "../src/domain/model";
import { apply, cleanName, createQueue } from "../src/domain/queue";
import { queueView, staffView } from "../src/domain/views";
import type { Command } from "../src/shared/protocol";

let nextId = 0;
const newId = () => `id-${++nextId}`;

function setup(counters = ["Room 1", "Room 2"]): QueueState {
  return createQueue(
    { code: "ABC234", name: "Test clinic", counters, serviceMinutes: 5, demo: false, staffKeyHash: "hash" },
    0,
    newId,
  );
}

function step(state: QueueState, command: Command, now = 1_000, deviceHash?: string): QueueState {
  const outcome = apply(state, command, { now, newId, deviceHash });
  if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
  return outcome.state;
}

function join(state: QueueState, device: string, now = 1_000, name = ""): QueueState {
  return step(state, { type: "join", device, name }, now, device);
}

function counterId(state: QueueState, index = 0): string {
  return state.config.counters[index]!.id;
}

function serving(state: QueueState, index = 0): number | null {
  const id = state.config.counters[index]!.serving;
  return id ? state.tickets.get(id)!.number : null;
}

function callNext(state: QueueState, index = 0, now = 2_000): QueueState {
  const counter = state.config.counters[index]!;
  return step(state, { type: "call_next", counterId: counter.id, expectServing: counter.serving }, now);
}

describe("joining", () => {
  it("numbers tickets in arrival order", () => {
    let state = setup();
    for (const device of ["a", "b", "c"]) state = join(state, device);
    expect(waitingInOrder(state).map((t) => t.number)).toEqual([1, 2, 3]);
  });

  it("gives a device that joins twice the same ticket, without a change", () => {
    let state = join(setup(), "a");
    const outcome = apply(state, { type: "join", device: "a" }, { now: 2_000, newId, deviceHash: "a" });
    expect(outcome.ok && outcome.result).toMatchObject({ type: "joined", existing: true, ticket: { number: 1 } });
    expect(outcome.ok && outcome.changed).toEqual([]);
    expect(outcome.ok && outcome.state.config.version).toBe(state.config.version);
    state = outcome.ok ? outcome.state : state;
    expect(waitingInOrder(state)).toHaveLength(1);
  });

  it("refuses joins while paused or closed", () => {
    for (const status of ["paused", "closed"] as const) {
      const state = step(setup(), { type: "set_status", status });
      const outcome = apply(state, { type: "join", device: "a" }, { now: 1, newId, deviceHash: "a" });
      expect(outcome).toMatchObject({ ok: false, code: `queue_${status}` });
    }
  });

  it("cleans names", () => {
    expect(cleanName("  Ravi\u0000‮   Kumar \n", 40)).toBe("Ravi Kumar");
    expect(cleanName("x".repeat(100), 40)).toHaveLength(40);
  });
});

describe("calling", () => {
  it("calls in order and finishes the previous ticket as served", () => {
    let state = setup();
    for (const device of ["a", "b"]) state = join(state, device);
    state = callNext(state);
    expect(serving(state)).toBe(1);
    state = callNext(state, 0, 3_000);
    expect(serving(state)).toBe(2);
    const first = [...state.tickets.values()].find((t) => t.number === 1)!;
    expect(first.status).toBe("served");
    expect(state.config.session.served).toBe(1);
  });

  it("lets two counters call different people", () => {
    let state = setup();
    for (const device of ["a", "b", "c"]) state = join(state, device);
    state = callNext(state, 0);
    state = callNext(state, 1);
    expect([serving(state, 0), serving(state, 1)]).toEqual([1, 2]);
    expect(waitingInOrder(state).map((t) => t.number)).toEqual([3]);
  });

  it("refuses a call from a screen that's behind (a double click)", () => {
    let state = setup();
    for (const device of ["a", "b"]) state = join(state, device);
    const stale = { type: "call_next" as const, counterId: counterId(state), expectServing: null };
    state = step(state, stale);
    const second = apply(state, stale, { now: 2_000, newId });
    expect(second).toMatchObject({ ok: false, code: "counter_changed" });
    expect(serving(state)).toBe(1);
    expect(waitingInOrder(state).map((t) => t.number)).toEqual([2]);
  });

  it("frees the counter when nobody is waiting", () => {
    let state = callNext(join(setup(), "a"));
    const outcome = apply(state, { type: "call_next", counterId: counterId(state), expectServing: state.config.counters[0]!.serving }, { now: 5_000, newId });
    expect(outcome.ok && outcome.result).toEqual({ type: "called", ticket: null });
    state = outcome.ok ? outcome.state : state;
    expect(serving(state)).toBeNull();
  });

  it("doesn't touch the state it was given", () => {
    const state = join(setup(), "a");
    const before = structuredClone({ config: state.config, tickets: [...state.tickets.values()] });
    callNext(state);
    expect({ config: state.config, tickets: [...state.tickets.values()] }).toEqual(before);
  });
});

describe("no-shows and leaving", () => {
  it("brings a missed ticket back to the front of the line", () => {
    let state = setup(["Room 1"]);
    for (const device of ["a", "b", "c"]) state = join(state, device);
    state = callNext(state);
    const first = state.config.counters[0]!.serving!;
    state = step(state, { type: "no_show", ticketId: first });
    expect(serving(state)).toBeNull();
    expect(state.tickets.get(first)!.status).toBe("missed");
    state = step(state, { type: "bring_back", ticketId: first });
    expect(waitingInOrder(state).map((t) => t.number)).toEqual([1, 2, 3]);
  });

  it("frees the counter when a called customer leaves", () => {
    let state = callNext(join(setup(), "a"));
    const ticket = state.config.counters[0]!.serving!;
    state = step(state, { type: "leave", ticketId: ticket, device: "a" }, 3_000, "a");
    expect(serving(state)).toBeNull();
    expect(state.tickets.get(ticket)!.status).toBe("left");
  });

  it("won't let another device remove someone's ticket", () => {
    const state = join(setup(), "a");
    const ticket = waitingInOrder(state)[0]!.id;
    const outcome = apply(state, { type: "leave", ticketId: ticket, device: "b" }, { now: 2, newId, deviceHash: "b" });
    expect(outcome).toMatchObject({ ok: false, code: "not_your_ticket" });
  });
});

describe("opening and closing", () => {
  it("only clears the line once it's paused or closed", () => {
    let state = join(join(setup(), "a"), "b");
    expect(apply(state, { type: "clear_waiting" }, { now: 2, newId })).toMatchObject({ ok: false, code: "invalid" });
    state = step(state, { type: "set_status", status: "closed" });
    state = step(state, { type: "clear_waiting" });
    expect(waitingInOrder(state)).toEqual([]);
  });

  it("restarts numbering when an empty line reopens", () => {
    let state = join(join(setup(), "a"), "b");
    state = step(state, { type: "set_status", status: "closed" });
    state = step(state, { type: "clear_waiting" });
    state = step(state, { type: "set_status", status: "open" });
    state = join(state, "c");
    expect(waitingInOrder(state).map((t) => t.number)).toEqual([1]);
  });

  it("won't remove a counter that's serving someone", () => {
    const state = callNext(join(setup(), "a"));
    const outcome = apply(
      state,
      { type: "set_counters", counters: [{ id: counterId(state, 1), name: "Room 2" }] },
      { now: 3, newId },
    );
    expect(outcome).toMatchObject({ ok: false, code: "counter_busy" });
  });
});

describe("scoring the wait shown", () => {
  const minute = 60_000;

  it("records the wait shown at joining and scores it when the person is called", () => {
    let state = setup(["Room 1"]);
    state = join(state, "a", 0);
    state = join(state, "b", 0);
    const [a, b] = waitingInOrder(state);
    expect(a!.estimateSeconds).toBe(0); // the room is free: called at once
    expect(b!.estimateSeconds).toBe(300); // one 5-minute service first
    state = callNext(state, 0, 1_000);
    state = callNext(state, 0, 4 * minute); // b waited 4 minutes against 5 shown: inside the range
    expect(state.config.totals.estimates).toMatchObject({ people: 2, withinRange: 2 });
    expect(state.config.session.estimates.people).toBe(2);
  });

  it("counts a wait far outside the range as wrong", () => {
    let state = setup(["Room 1"]);
    state = join(state, "a", 0);
    state = join(state, "b", 0);
    state = callNext(state, 0, 1_000);
    state = callNext(state, 0, 30 * minute); // 30 minutes against 5 shown
    expect(state.config.totals.estimates).toMatchObject({ people: 2, withinRange: 1 });
  });

  it("doesn't score someone brought back after missing their turn", () => {
    let state = setup(["Room 1"]);
    state = join(state, "a", 0);
    state = callNext(state, 0, 1_000);
    const ticket = state.config.counters[0]!.serving!;
    state = step(state, { type: "no_show", ticketId: ticket }, 2 * minute);
    state = step(state, { type: "bring_back", ticketId: ticket }, 3 * minute);
    expect(state.tickets.get(ticket)!.estimateSeconds).toBeNull();
    state = callNext(state, 0, 4 * minute);
    expect(state.config.totals.estimates.people).toBe(1);
  });

  it("doesn't score the demo's simulated customers", () => {
    const outcome = apply(setup(), { type: "join", device: "sim" }, { now: 0, newId, deviceHash: "sim", simulated: true });
    expect(outcome.ok && [...outcome.state.tickets.values()][0]!.estimateSeconds).toBeNull();
  });

  it("keeps lifetime totals when a new session starts", () => {
    let state = callNext(join(setup(["Room 1"]), "a", 0), 0, 1_000);
    state = callNext(state, 0, 2_000); // serve a
    state = step(state, { type: "set_status", status: "closed" });
    state = step(state, { type: "set_status", status: "open" });
    expect(state.config.session.served).toBe(0);
    expect(state.config.totals).toMatchObject({ served: 1, estimates: { people: 1 } });
  });
});

describe("views", () => {
  it("never puts names in the public view", () => {
    const state = callNext(join(join(setup(), "a", 1, "Priya Sharma"), "b", 2, "Arjun Rao"));
    const text = JSON.stringify(queueView(state, 3_000));
    expect(text).not.toContain("Priya");
    expect(text).not.toContain("Arjun");
    expect(JSON.stringify(staffView(state, 3_000))).toContain("Arjun");
  });
});

describe("the wait estimator", () => {
  const minute = 60_000;

  it("moves from the host's guess toward real services", () => {
    let e = trackLine(initialEstimator(300, 0), 3, 0);
    e = recordService(e, 1 * minute, 3 * minute); // 120 s
    expect(e.serviceSeconds).toBe(210); // halfway: the guess counts as one sample
    for (let i = 0; i < 20; i++) e = recordService(e, 10 * minute, 12 * minute);
    expect(Math.abs(e.serviceSeconds - 120)).toBeLessThan(2);
  });

  it("drops a service if the line ran empty during it", () => {
    let e = initialEstimator(300, 0);
    e = trackLine(e, 2, 0);
    e = trackLine(e, 0, 5 * minute); // empty at 5 min
    e = trackLine(e, 1, 9 * minute);
    expect(recordService(e, 4 * minute, 10 * minute)).toEqual(e);
    expect(recordService(e, 6 * minute, 8 * minute).samples).toBe(1);
  });

  it("clamps a service that's far too long", () => {
    const e = trackLine(initialEstimator(60, 0), 3, 0);
    expect(recordService(e, minute, 61 * minute).serviceSeconds).toBe(60 + 0.5 * (240 - 60));
  });

  const paceOf = (state: QueueState, now: number) =>
    pace(state.config.estimator, state.config.counters, (id) => state.tickets.get(id)?.calledAt ?? null, now);

  it("assumes every counter opens before anyone is called", () => {
    const state = setup(["A", "B", "C"]);
    expect(paceOf(state, 0)).toEqual({ secondsPerTicket: 100, free: 3, nextFreeIn: 100 });
  });

  it("counts free counters and how far along the busy ones are", () => {
    let state = setup(["A", "B"]);
    for (const device of ["a", "b", "c", "d"]) state = join(state, device);
    state = callNext(state, 0, 0); // A busy since 0
    state = callNext(state, 1, 0); // B busy since 0
    const p = paceOf(state, 2 * minute); // 2 of 5 minutes gone
    expect(p).toEqual({ secondsPerTicket: 150, free: 0, nextFreeIn: 180 });
    expect(expectedWait(1, p)).toBe(180);
    expect(expectedWait(2, p)).toBe(330);
    // A counter that's done and free calls the next person almost at once.
    state = step(state, { type: "finish", ticketId: state.config.counters[0]!.serving! }, 3 * minute);
    expect(expectedWait(1, paceOf(state, 3 * minute))).toBe(0);
  });
});
