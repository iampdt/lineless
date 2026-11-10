// Every change to a queue is a command applied to its state by `apply`. It's a pure function:
// it never mutates the state it's given, it returns the next state with the tickets that
// changed, and it has no I/O. The Durable Object runs it synchronously between reading and
// persisting, which is why two commands can never interleave (docs/architecture.md).

import { type Command, type CommandResult, type ErrorCode, LIMITS } from "../shared/protocol";
import {
  DEFAULT_ESTIMATOR,
  type EstimatorOptions,
  initialEstimator,
  recordService,
  trackLine,
} from "./estimate";
import { type Counter, type QueueConfig, type QueueState, type Session, type Ticket, waitingInOrder } from "./model";

export interface ApplyContext {
  now: number;
  newId: () => string;
  /** SHA-256 of the device id in a join or leave command, computed by the caller. */
  deviceHash?: string;
  /** Set for the demo's simulated customers. */
  simulated?: boolean;
  estimator?: EstimatorOptions;
}

export interface QueueEvent {
  type: string;
  ticketId: string | null;
  counterId: string | null;
}

export type Outcome =
  | { ok: true; state: QueueState; result: CommandResult; changed: Ticket[]; events: QueueEvent[] }
  | { ok: false; code: ErrorCode; message: string };

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface NewQueue {
  code: string;
  name: string;
  counters: string[];
  serviceMinutes: number;
  demo: boolean;
  staffKeyHash: string;
}

export function createQueue(input: NewQueue, now: number, newId: () => string): QueueState {
  const config: QueueConfig = {
    code: input.code,
    name: cleanName(input.name, LIMITS.queueName) || "Queue",
    demo: input.demo,
    createdAt: now,
    staffKeyHash: input.staffKeyHash,
    status: "open",
    version: 1,
    nextNumber: 1,
    nextOrder: 1,
    counters: input.counters.map((name, i) => ({
      id: newId(),
      name: cleanName(name, LIMITS.counterName) || `Counter ${i + 1}`,
      serving: null,
      lastActiveAt: 0,
    })),
    session: newSession(now),
    estimator: initialEstimator(input.serviceMinutes * 60, now),
    lastActivityAt: now,
    autoServe: false,
  };
  return { config, tickets: new Map() };
}

function newSession(now: number): Session {
  return { startedAt: now, served: 0, missed: 0, left: 0, waitTotalMs: 0, waitCount: 0, serviceTotalMs: 0, serviceCount: 0 };
}

/** Accumulates one command's changes on copies, leaving the original state untouched. */
class Draft {
  readonly config: QueueConfig;
  readonly tickets: Map<string, Ticket>;
  readonly changed = new Map<string, Ticket>();
  readonly events: QueueEvent[] = [];
  private touched = false;

  constructor(
    state: QueueState,
    readonly ctx: ApplyContext,
  ) {
    this.config = structuredClone(state.config);
    this.tickets = new Map(state.tickets);
  }

  ticket(id: string): Ticket {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new DomainError("ticket_not_found", "That ticket isn't in this queue.");
    return ticket;
  }

  counter(id: string): Counter {
    const counter = this.config.counters.find((c) => c.id === id);
    if (!counter) throw new DomainError("counter_not_found", "That counter doesn't exist.");
    return counter;
  }

  update(ticket: Ticket, patch: Partial<Ticket>): Ticket {
    const next = { ...ticket, ...patch };
    this.tickets.set(next.id, next);
    this.changed.set(next.id, next);
    this.touched = true;
    return next;
  }

  insert(ticket: Ticket): void {
    this.tickets.set(ticket.id, ticket);
    this.changed.set(ticket.id, ticket);
    this.touched = true;
  }

  touch(): void {
    this.touched = true;
  }

  event(type: string, ticketId: string | null = null, counterId: string | null = null): void {
    this.events.push({ type, ticketId, counterId });
  }

  /** Finish the counter's current ticket, if any, as served. */
  finishServing(counter: Counter): void {
    if (counter.serving === null) return;
    const ticket = this.ticket(counter.serving);
    const now = this.ctx.now;
    this.update(ticket, { status: "served", finishedAt: now });
    const session = this.config.session;
    session.served += 1;
    if (ticket.calledAt !== null) {
      session.serviceTotalMs += now - ticket.calledAt;
      session.serviceCount += 1;
      this.config.estimator = recordService(
        this.config.estimator,
        ticket.calledAt,
        now,
        this.ctx.estimator ?? DEFAULT_ESTIMATOR,
      );
    }
    counter.serving = null;
    counter.lastActiveAt = now;
    this.event("served", ticket.id, counter.id);
  }

  /** Free whichever counter is serving `ticket`. */
  release(ticket: Ticket): void {
    const counter = this.config.counters.find((c) => c.serving === ticket.id);
    if (counter) {
      counter.serving = null;
      counter.lastActiveAt = this.ctx.now;
    }
  }

  finish(result: CommandResult): Outcome {
    if (!this.touched) {
      return { ok: true, state: { config: this.config, tickets: this.tickets }, result, changed: [], events: [] };
    }
    const now = this.ctx.now;
    this.config.version += 1;
    this.config.lastActivityAt = now;
    let waiting = 0;
    for (const ticket of this.tickets.values()) if (ticket.status === "waiting") waiting += 1;
    this.config.estimator = trackLine(this.config.estimator, waiting, now);
    return {
      ok: true,
      state: { config: this.config, tickets: this.tickets },
      result,
      changed: [...this.changed.values()],
      events: this.events,
    };
  }
}

const OK: CommandResult = { type: "ok" };

export function apply(state: QueueState, command: Command, ctx: ApplyContext): Outcome {
  const draft = new Draft(state, ctx);
  try {
    return draft.finish(run(draft, command));
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

function run(d: Draft, command: Command): CommandResult {
  const { now } = d.ctx;
  const config = d.config;

  switch (command.type) {
    case "join": {
      const deviceHash = requireDevice(d.ctx);
      // One ticket per device: a double tap or a retried request gets the same ticket back.
      for (const ticket of d.tickets.values()) {
        if (ticket.deviceHash === deviceHash && (ticket.status === "waiting" || ticket.status === "called")) {
          return { type: "joined", ticket: { id: ticket.id, number: ticket.number }, existing: true };
        }
      }
      if (config.status === "paused") throw new DomainError("queue_paused", "This line isn't taking new people right now.");
      if (config.status === "closed") throw new DomainError("queue_closed", "This line is closed.");
      const limit = config.demo ? LIMITS.demoWaiting : LIMITS.waiting;
      if (waitingInOrder(d).length >= limit) throw new DomainError("queue_full", "This line is full.");

      const ticket: Ticket = {
        id: d.ctx.newId(),
        number: config.nextNumber,
        name: cleanName(command.name ?? "", LIMITS.customerName),
        deviceHash,
        status: "waiting",
        counterId: null,
        order: config.nextOrder,
        joinedAt: now,
        calledAt: null,
        finishedAt: null,
        recalls: 0,
        simulated: d.ctx.simulated ?? false,
      };
      config.nextNumber += 1;
      config.nextOrder += 1;
      d.insert(ticket);
      d.event("joined", ticket.id);
      return { type: "joined", ticket: { id: ticket.id, number: ticket.number }, existing: false };
    }

    case "leave": {
      const ticket = d.ticket(command.ticketId);
      if (ticket.deviceHash !== requireDevice(d.ctx)) throw new DomainError("not_your_ticket", "That ticket belongs to another device.");
      if (ticket.status !== "waiting" && ticket.status !== "called") return OK;
      d.release(ticket);
      d.update(ticket, { status: "left", finishedAt: now, counterId: null });
      config.session.left += 1;
      d.event("left", ticket.id);
      return OK;
    }

    case "call_next": {
      const counter = d.counter(command.counterId);
      // Compare-and-set on the counter: a double click, or two people at one counter, finds the
      // counter already moved on and is refused instead of skipping someone.
      if (counter.serving !== command.expectServing) {
        throw new DomainError("counter_changed", "This counter already moved on. Check the screen and try again.");
      }
      d.finishServing(counter);
      const next = waitingInOrder(d)[0];
      if (!next) {
        d.touch();
        return { type: "called", ticket: null };
      }
      d.update(next, { status: "called", counterId: counter.id, calledAt: now });
      counter.serving = next.id;
      counter.lastActiveAt = now;
      config.session.waitTotalMs += now - next.joinedAt;
      config.session.waitCount += 1;
      d.event("called", next.id, counter.id);
      return { type: "called", ticket: { id: next.id, number: next.number } };
    }

    case "recall": {
      const ticket = calledTicket(d, command.ticketId);
      d.update(ticket, { recalls: ticket.recalls + 1 });
      d.event("recalled", ticket.id, ticket.counterId);
      return OK;
    }

    case "finish": {
      const ticket = calledTicket(d, command.ticketId);
      const counter = d.counter(ticket.counterId ?? "");
      if (counter.serving !== ticket.id) throw new DomainError("ticket_changed", "That counter has moved on.");
      d.finishServing(counter);
      return OK;
    }

    case "no_show": {
      const ticket = calledTicket(d, command.ticketId);
      d.release(ticket);
      d.update(ticket, { status: "missed", finishedAt: now });
      config.session.missed += 1;
      d.event("missed", ticket.id, ticket.counterId);
      return OK;
    }

    case "bring_back": {
      const ticket = d.ticket(command.ticketId);
      if (ticket.status !== "missed") throw new DomainError("ticket_changed", "Only a missed ticket can be brought back.");
      // Back to the front: they were called once already.
      const front = waitingInOrder(d)[0];
      const order = front ? front.order - 1 : config.nextOrder++;
      d.update(ticket, { status: "waiting", order, counterId: null, calledAt: null, finishedAt: null });
      d.event("brought_back", ticket.id);
      return OK;
    }

    case "set_status": {
      if (command.status === config.status) return OK;
      if (config.status === "closed" && command.status === "open") reopen(d);
      config.status = command.status;
      d.touch();
      d.event(`status_${command.status}`);
      return OK;
    }

    case "clear_waiting": {
      if (config.status === "open") {
        throw new DomainError("invalid", "Pause or close the line before clearing it.");
      }
      for (const ticket of waitingInOrder(d)) {
        d.update(ticket, { status: "cleared", finishedAt: now });
      }
      d.touch();
      d.event("cleared");
      return OK;
    }

    case "set_counters": {
      setCounters(d, command.counters);
      d.touch();
      d.event("counters_changed");
      return OK;
    }

    case "set_auto_serve": {
      if (!config.demo) throw new DomainError("not_demo", "Auto-serve only runs in the demo.");
      config.autoServe = command.on;
      d.touch();
      return OK;
    }
  }
}

function requireDevice(ctx: ApplyContext): string {
  if (!ctx.deviceHash) throw new DomainError("invalid", "Missing device.");
  return ctx.deviceHash;
}

function calledTicket(d: Draft, id: string): Ticket {
  const ticket = d.ticket(id);
  if (ticket.status !== "called") {
    throw new DomainError("ticket_changed", `Ticket ${ticket.number} isn't at a counter any more.`);
  }
  return ticket;
}

/**
 * Opening a closed queue with nobody left in it starts a new session: numbers restart at 1 and
 * the totals reset. Missed tickets from before are cleared so their numbers can't collide.
 */
function reopen(d: Draft): void {
  for (const ticket of d.tickets.values()) {
    if (ticket.status === "waiting" || ticket.status === "called") return;
  }
  for (const ticket of d.tickets.values()) {
    if (ticket.status === "missed") d.update(ticket, { status: "cleared" });
  }
  d.config.nextNumber = 1;
  d.config.session = newSession(d.ctx.now);
}

function setCounters(d: Draft, wanted: { id: string | null; name: string }[]): void {
  if (wanted.length === 0 || wanted.length > LIMITS.counters) {
    throw new DomainError("invalid", `A line needs 1 to ${LIMITS.counters} counters.`);
  }
  const current = new Map(d.config.counters.map((c) => [c.id, c]));
  const next: Counter[] = wanted.map(({ id, name }) => {
    const clean = cleanName(name, LIMITS.counterName);
    if (!clean) throw new DomainError("invalid", "Every counter needs a name.");
    if (id === null) return { id: d.ctx.newId(), name: clean, serving: null, lastActiveAt: 0 };
    const existing = current.get(id);
    if (!existing) throw new DomainError("counter_not_found", "That counter doesn't exist.");
    current.delete(id);
    return { ...existing, name: clean };
  });
  for (const removed of current.values()) {
    if (removed.serving !== null) {
      throw new DomainError("counter_busy", `${removed.name} is serving someone. Finish first, then remove it.`);
    }
  }
  d.config.counters = next;
}

/** Trim, collapse whitespace, drop control characters, and cap the length. */
export function cleanName(value: string, max: number): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
