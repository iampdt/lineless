// The wire protocol between the web app and the Worker. Commands go over HTTP, each with a
// request id so a retry is answered from the first attempt; state comes back over a WebSocket
// as a full snapshot with a version. Both sides import these types.

import type { Pace } from "./estimate";

export type QueueStatus = "open" | "paused" | "closed";

export type TicketStatus =
  | "waiting" // in line
  | "called" // asked to come to a counter
  | "served" // finished at a counter
  | "missed" // called but didn't come; staff can bring them back
  | "left" // the customer left the line
  | "cleared"; // removed when staff cleared the line at closing

export interface CounterView {
  id: string;
  name: string;
  /** Number of the ticket being served, or null while the counter is free. */
  serving: number | null;
  /** Recalls of the ticket being served; screens chime again when it goes up. */
  recalls: number;
}

/** What anyone with the queue's code may see: numbers, never names. */
export interface QueueView {
  version: number;
  code: string;
  name: string;
  status: QueueStatus;
  demo: boolean;
  counters: CounterView[];
  /** Waiting ticket numbers, front of the line first. */
  waiting: number[];
  /** How fast the line moves; `expectedWait` in estimate.ts turns it into a wait. */
  pace: Pace;
  serverTime: number;
}

export interface TicketView {
  id: string;
  number: number;
  name: string;
  status: TicketStatus;
  counterId: string | null;
  joinedAt: number;
  calledAt: number | null;
  recalls: number;
}

/** How the wait shown at joining compared with the real wait. */
export interface EstimateStats {
  people: number;
  /** Share whose real wait fell inside the range shown, 0–1; null before anyone is scored. */
  withinRange: number | null;
  averageErrorSeconds: number | null;
}

export interface SessionStats {
  startedAt: number;
  served: number;
  missed: number;
  left: number;
  averageWaitSeconds: number | null;
  averageServiceSeconds: number | null;
  estimates: EstimateStats;
}

/** What the staff console sees, on top of the queue view. */
export interface StaffView {
  waiting: TicketView[];
  called: TicketView[];
  /** Missed in the last two hours, newest first. */
  missed: TicketView[];
  stats: SessionStats;
  /** Over the queue's whole life: what a trial reports. */
  totals: { served: number; estimates: EstimateStats };
  autoServe: boolean;
}

/** A customer's own ticket. */
export interface YouView {
  id: string;
  number: number;
  status: TicketStatus;
  /** 1 when next in line; null unless waiting. */
  position: number | null;
  counterName: string | null;
  recalls: number;
}

export type ServerMessage =
  | { type: "state"; queue: QueueView; staff?: StaffView; you?: YouView | null }
  | { type: "denied"; reason: "bad_key" | "unknown_ticket" }
  | { type: "gone" };

export type ClientMessage = {
  type: "hello";
  staffKey?: string;
  ticket?: { id: string; device: string };
};

/** Keep-alive frames, answered by the runtime without waking the queue's object. */
export const PING = '{"type":"ping"}';
export const PONG = '{"type":"pong"}';

export type Command =
  | { type: "join"; device: string; name?: string }
  | { type: "add_ticket"; name?: string }
  | { type: "leave"; ticketId: string; device: string }
  | { type: "call_next"; counterId: string; expectServing: string | null }
  | { type: "recall"; ticketId: string }
  | { type: "finish"; ticketId: string }
  | { type: "no_show"; ticketId: string }
  | { type: "bring_back"; ticketId: string }
  | { type: "set_status"; status: QueueStatus }
  | { type: "clear_waiting" }
  | { type: "set_counters"; counters: { id: string | null; name: string }[] }
  | { type: "set_auto_serve"; on: boolean };

export type CommandType = Command["type"];

/** Commands a customer may send; every other command needs the staff key. */
export const CUSTOMER_COMMANDS: ReadonlySet<CommandType> = new Set(["join", "leave"]);

export type CommandResult =
  | { type: "joined"; ticket: { id: string; number: number }; existing: boolean }
  | { type: "called"; ticket: { id: string; number: number } | null }
  | { type: "ok" };

export interface CommandRequest {
  /** Chosen by the client and reused on retries: the same id never applies twice. */
  requestId: string;
  command: Command;
}

export type ErrorCode =
  | "invalid"
  | "not_found"
  | "unauthorized"
  | "rate_limited"
  | "request_reused"
  | "queue_paused"
  | "queue_closed"
  | "queue_full"
  | "counter_not_found"
  | "counter_changed"
  | "counter_busy"
  | "ticket_not_found"
  | "ticket_changed"
  | "not_your_ticket"
  | "not_demo"
  | "internal";

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

export interface CreatedQueue {
  code: string;
  staffKey: string;
}

export const LIMITS = {
  queueName: 60,
  counterName: 24,
  customerName: 40,
  counters: 12,
  waiting: 500,
  demoWaiting: 40,
  serviceMinutes: { min: 1, max: 120 },
} as const;
