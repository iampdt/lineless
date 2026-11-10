// The queue as the domain sees it. Plain data with no runtime dependencies, so the same code
// runs in the Durable Object, in tests and in the wait-time simulation.

import type { QueueStatus, TicketStatus } from "../shared/protocol";
import type { EstimatorState } from "./estimate";

export interface Counter {
  id: string;
  name: string;
  /** Id of the ticket being served, or null while free. */
  serving: string | null;
  /** When this counter last called or finished someone; 0 if never. */
  lastActiveAt: number;
}

export interface Ticket {
  id: string;
  number: number;
  /** Optional, shown only to staff. */
  name: string;
  /** SHA-256 of the customer's device id, which is their credential for this ticket. */
  deviceHash: string;
  status: TicketStatus;
  counterId: string | null;
  /** Position key among waiting tickets: lower goes first. */
  order: number;
  joinedAt: number;
  calledAt: number | null;
  finishedAt: number | null;
  recalls: number;
  /** Joined by the demo's simulated customers. */
  simulated: boolean;
  /** The expected wait shown when they joined, scored against the real one; null if brought back. */
  estimateSeconds: number | null;
}

/** How the wait shown at joining compared with the real wait. */
export interface Accuracy {
  people: number;
  withinRange: number;
  errorTotalSeconds: number;
}

/** Totals since the queue last opened, for the staff console. */
export interface Session {
  startedAt: number;
  served: number;
  missed: number;
  left: number;
  waitTotalMs: number;
  waitCount: number;
  serviceTotalMs: number;
  serviceCount: number;
  estimates: Accuracy;
}

/** Totals over the queue's whole life, kept across sessions: what a trial reports. */
export interface Totals {
  served: number;
  estimates: Accuracy;
}

export interface QueueConfig {
  code: string;
  name: string;
  demo: boolean;
  createdAt: number;
  staffKeyHash: string;
  status: QueueStatus;
  /** Increments on every change; clients keep the newest snapshot they've seen. */
  version: number;
  nextNumber: number;
  nextOrder: number;
  counters: Counter[];
  session: Session;
  estimator: EstimatorState;
  lastActivityAt: number;
  autoServe: boolean;
  totals: Totals;
}

/**
 * The queue's working set: its configuration plus the tickets that are still in play (waiting
 * or called) or finished recently enough to matter (a missed ticket can be brought back; a
 * customer's page shows "served" for a while).
 */
export interface QueueState {
  config: QueueConfig;
  tickets: Map<string, Ticket>;
}

/** Finished tickets stay in the working set this long. */
export const RECENT_MS = 2 * 60 * 60 * 1000;

export function emptyAccuracy(): Accuracy {
  return { people: 0, withinRange: 0, errorTotalSeconds: 0 };
}

export function isActive(ticket: Ticket): boolean {
  return ticket.status === "waiting" || ticket.status === "called";
}

/** Waiting tickets, front of the line first. */
export function waitingInOrder(state: QueueState): Ticket[] {
  const waiting: Ticket[] = [];
  for (const ticket of state.tickets.values()) {
    if (ticket.status === "waiting") waiting.push(ticket);
  }
  return waiting.sort((a, b) => a.order - b.order);
}
