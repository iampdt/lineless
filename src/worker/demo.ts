// The public demo is a real queue with simulated customers. Arrivals and the optional
// auto-serve run on the queue's alarm, only while someone has the demo open.

import { apply, type Outcome } from "../domain/queue";
import { type QueueState, waitingInOrder } from "../domain/model";
import type { Command } from "../shared/protocol";
import { newId } from "./ids";

const NAMES = [
  "Aarav", "Diya", "Kabir", "Meera", "Rohan", "Sara", "Ishaan", "Anaya", "Vivaan", "Zoya",
  "Arjun", "Myra", "Dev", "Tara", "Neel", "Kiara", "Reyansh", "Ira", "Yash", "Aditi",
];

export const DEMO_QUEUE = {
  name: "Sunrise Clinic (demo)",
  counters: ["Room 1", "Room 2"],
  serviceMinutes: 1,
};

/** Waiting length the simulated arrivals stop at, so the visitor's own ticket keeps moving. */
const ARRIVALS_UNTIL = 6;

function randomName(): string {
  return NAMES[Math.floor(Math.random() * NAMES.length)] ?? "Guest";
}

/** Five people who arrived over the last few minutes; both rooms already serving. */
export function seedDemo(state: QueueState, now: number): Extract<Outcome, { ok: true }>[] {
  const outcomes: Extract<Outcome, { ok: true }>[] = [];
  let current = state;
  const step = (command: Command, at: number) => {
    const outcome = apply(current, command, { now: at, newId, deviceHash: `sim:${newId()}`, simulated: true });
    if (outcome.ok) {
      outcomes.push(outcome);
      current = outcome.state;
    }
  };
  for (let i = 0; i < 5; i++) step({ type: "join", device: "sim", name: randomName() }, now - (9 - i) * 60_000);
  current.config.counters.forEach((counter, i) => {
    step({ type: "call_next", counterId: counter.id, expectServing: null }, now - (2 - i) * 60_000);
  });
  return outcomes;
}

export function simulatedArrival(state: QueueState): Command | null {
  if (state.config.status !== "open") return null;
  if (waitingInOrder(state).length >= ARRIVALS_UNTIL || Math.random() > 0.35) return null;
  return { type: "join", device: "sim", name: randomName() };
}

/** Auto-serve: free counters call the next person; busy ones move on after 20–45 seconds. */
export function simulatedCalls(state: QueueState, now: number): Command[] {
  let waiting = waitingInOrder(state).length;
  const commands: Command[] = [];
  for (const counter of state.config.counters) {
    const serving = counter.serving ? state.tickets.get(counter.serving) : undefined;
    const due = serving?.calledAt != null && now - serving.calledAt > 20_000 + Math.random() * 25_000;
    if ((serving === undefined && waiting > 0) || due) {
      commands.push({ type: "call_next", counterId: counter.id, expectServing: counter.serving });
      if (waiting > 0) waiting -= 1;
    }
  }
  return commands;
}
