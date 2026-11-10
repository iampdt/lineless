// One Durable Object per queue. It owns the queue's state, applies every command to it, and
// pushes the result to every connected screen.
//
// Correctness rests on one property: between reading the state and persisting the next one,
// `commit` runs synchronous code only. A Durable Object handles one event at a time and only
// switches at an `await`, so no other command can see or change the queue halfway through. The
// awaits (hashing) all happen before the state is read.

import { DurableObject } from "cloudflare:workers";
import { apply, createQueue, type NewQueue, type Outcome } from "../domain/queue";
import type { QueueState, Ticket } from "../domain/model";
import { positions, queueView, staffView, youView } from "../domain/views";
import {
  type ClientMessage,
  type Command,
  type CommandRequest,
  type CommandResult,
  CUSTOMER_COMMANDS,
  type ErrorCode,
  PING,
  PONG,
  type QueueView,
  type ServerMessage,
} from "../shared/protocol";
import { newId, sameDigest, sha256 } from "./ids";
import {
  exists,
  migrate,
  prune,
  readRequest,
  readState,
  readTicket,
  reportRows,
  saveConfig,
  saveEvents,
  saveRequest,
  saveTickets,
} from "./storage";
import { simulatedArrival, simulatedCalls, seedDemo } from "./demo";
import { reportCsv } from "./report";

type Attachment = { role: "public" } | { role: "staff" } | { role: "customer"; ticketId: string };

export type CommandReply =
  | { ok: true; result: CommandResult }
  | { ok: false; status: number; code: ErrorCode; message: string };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Leading-edge broadcast, then at most one more per gap: bursts of commands coalesce. */
const BROADCAST_GAP_MS = 50;
export const MAX_SOCKETS = 2000;
/** Joins per client address per queue: generous enough for a clinic's shared Wi-Fi. */
export const JOIN_LIMIT = { count: 30, windowMs: 10 * MINUTE };
const QUEUE_IDLE_TTL_MS = 30 * DAY;
const DEMO_TTL_MS = DAY;
const HOUSEKEEPING_MS = 6 * HOUR;

const STATUS: Record<ErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  unauthorized: 401,
  rate_limited: 429,
  request_reused: 422,
  queue_paused: 409,
  queue_closed: 409,
  queue_full: 409,
  counter_not_found: 404,
  counter_changed: 409,
  counter_busy: 409,
  ticket_not_found: 404,
  ticket_changed: 409,
  not_your_ticket: 403,
  not_demo: 400,
  internal: 500,
};

export class QueueObject extends DurableObject<Env> {
  /** undefined until loaded; null when this object holds no queue. */
  private state: QueueState | null | undefined;
  private lastBroadcastAt = 0;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPruneAt = 0;
  private joins = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alives are answered by the runtime and don't wake a hibernating object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /** The queue, read once per wake-up. Unknown codes never create a database. */
  private load(): QueueState | null {
    if (this.state === undefined) this.state = readState(this.sql, Date.now());
    return this.state;
  }

  async create(input: NewQueue): Promise<boolean> {
    if (exists(this.sql) && this.load()) return false;
    migrate(this.sql);
    const now = Date.now();
    const state = createQueue(input, now, newId);
    this.ctx.storage.transactionSync(() => saveConfig(this.sql, state.config));
    this.state = state;
    if (input.demo) for (const outcome of seedDemo(state, now)) this.persist(outcome);
    await this.scheduleAlarm();
    return true;
  }

  async view(): Promise<QueueView | null> {
    const state = this.load();
    return state ? queueView(state, Date.now()) : null;
  }

  /** The staff report as CSV, or null without the right staff key or queue. */
  async report(staffKey: string | null): Promise<{ ok: true; csv: string } | { ok: false; status: number; code: ErrorCode }> {
    const staffHash = staffKey ? await sha256(staffKey) : null;
    const state = this.load();
    if (!state) return { ok: false, status: 404, code: "not_found" };
    if (!staffHash || !sameDigest(staffHash, state.config.staffKeyHash)) return { ok: false, status: 401, code: "unauthorized" };
    return { ok: true, csv: reportCsv(reportRows(this.sql), state.config.counters) };
  }

  async run(request: CommandRequest, staffKey: string | null, client: string): Promise<CommandReply> {
    const { command } = request;
    // Every await happens here, before the state is read.
    const fingerprint = await sha256(JSON.stringify(command));
    const staffHash = staffKey ? await sha256(staffKey) : null;
    const deviceHash = "device" in command ? await sha256(command.device) : undefined;

    const state = this.load();
    if (!state) return fail("not_found", "There's no line with that code. It may have expired.");
    const now = Date.now();

    const previous = readRequest(this.sql, request.requestId, now);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return fail("request_reused", "That request id was already used for a different command.");
      }
      return { ok: true, result: previous.result };
    }

    if (!CUSTOMER_COMMANDS.has(command.type)) {
      if (!staffHash || !sameDigest(staffHash, state.config.staffKeyHash)) {
        return fail("unauthorized", "This needs the staff link.");
      }
    }
    if (command.type === "join" && !this.allowJoin(client, now)) {
      return fail("rate_limited", "Too many joins from this network. Try again in a few minutes.");
    }

    const outcome = apply(state, command, { now, newId, deviceHash });
    if (!outcome.ok) return fail(outcome.code, outcome.message);
    this.persist(outcome, { id: request.requestId, fingerprint });
    await this.scheduleAlarm();
    return { ok: true, result: outcome.result };
  }

  /** Write the outcome in one transaction, then make it the current state and tell everyone. */
  private persist(outcome: Extract<Outcome, { ok: true }>, request?: { id: string; fingerprint: string }): void {
    const now = Date.now();
    const changed = outcome.changed.length > 0 || outcome.state.config.version !== this.state?.config.version;
    this.ctx.storage.transactionSync(() => {
      if (changed) {
        saveConfig(this.sql, outcome.state.config);
        saveTickets(this.sql, outcome.changed);
        saveEvents(this.sql, outcome.events, now);
      }
      if (request) saveRequest(this.sql, request.id, request.fingerprint, outcome.result, now);
    });
    this.state = outcome.state;
    if (changed) this.broadcast();
  }

  private allowJoin(client: string, now: number): boolean {
    if (this.joins.size > 10_000) this.joins.clear();
    const recent = (this.joins.get(client) ?? []).filter((t) => t > now - JOIN_LIMIT.windowMs);
    if (recent.length >= JOIN_LIMIT.count) return false;
    recent.push(now);
    this.joins.set(client, recent);
    return true;
  }

  // ---- WebSockets ----

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const state = this.load();
    if (!state) return new Response("Not found", { status: 404 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response("Too many viewers", { status: 503 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { role: "public" };
    server.serializeAttachment(attachment);
    server.send(this.message(state, attachment, Date.now()));
    // A demo starts moving once someone is watching.
    if (state.config.demo) await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string" || data.length > 2048) return;
    let message: ClientMessage;
    try {
      message = JSON.parse(data) as ClientMessage;
    } catch {
      return;
    }
    if (message?.type !== "hello") return;
    const staffHash = typeof message.staffKey === "string" ? await sha256(message.staffKey) : null;
    const ticket = message.ticket;
    const deviceHash = typeof ticket?.device === "string" ? await sha256(ticket.device) : null;

    const state = this.load();
    if (!state) {
      send(ws, { type: "gone" });
      return;
    }
    let attachment: Attachment = { role: "public" };
    if (staffHash !== null) {
      if (!sameDigest(staffHash, state.config.staffKeyHash)) {
        send(ws, { type: "denied", reason: "bad_key" });
        return;
      }
      attachment = { role: "staff" };
    } else if (ticket && typeof ticket.id === "string") {
      const found = this.findTicket(state, ticket.id);
      if (!found || found.deviceHash !== deviceHash) {
        send(ws, { type: "denied", reason: "unknown_ticket" });
        return;
      }
      attachment = { role: "customer", ticketId: found.id };
    }
    ws.serializeAttachment(attachment);
    ws.send(this.message(state, attachment, Date.now()));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private findTicket(state: QueueState, id: string): Ticket | null {
    return state.tickets.get(id) ?? readTicket(this.sql, id);
  }

  private broadcast(): void {
    const since = Date.now() - this.lastBroadcastAt;
    if (since >= BROADCAST_GAP_MS) {
      this.flush();
    } else if (!this.broadcastTimer) {
      this.broadcastTimer = setTimeout(() => {
        this.broadcastTimer = null;
        this.flush();
      }, BROADCAST_GAP_MS - since);
    }
  }

  /** Send the current state to every socket: one serialisation per audience, not per socket. */
  private flush(): void {
    const state = this.load();
    if (!state) return;
    const now = Date.now();
    const queueJson = JSON.stringify(queueView(state, now));
    let staffJson: string | null = null;
    let position: Map<string, number> | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = (ws.deserializeAttachment() as Attachment | null) ?? { role: "public" };
      let text: string;
      if (attachment.role === "staff") {
        staffJson ??= JSON.stringify(staffView(state, now));
        text = `{"type":"state","queue":${queueJson},"staff":${staffJson}}`;
      } else if (attachment.role === "customer") {
        position ??= positions(state);
        const ticket = state.tickets.get(attachment.ticketId);
        const you = ticket ? JSON.stringify(youView(state, ticket, position)) : "null";
        text = `{"type":"state","queue":${queueJson},"you":${you}}`;
      } else {
        text = `{"type":"state","queue":${queueJson}}`;
      }
      try {
        ws.send(text);
      } catch {
        // The socket closed between listing and sending; its close handler cleans up.
      }
    }
    this.lastBroadcastAt = Date.now();
  }

  private message(state: QueueState, attachment: Attachment, now: number): string {
    const message: ServerMessage = { type: "state", queue: queueView(state, now) };
    if (attachment.role === "staff") message.staff = staffView(state, now);
    if (attachment.role === "customer") {
      const ticket = this.findTicket(state, attachment.ticketId);
      message.you = ticket ? youView(state, ticket, positions(state)) : null;
    }
    return JSON.stringify(message);
  }

  // ---- Alarms: expiry, housekeeping, and the demo's simulated customers ----

  async alarm(): Promise<void> {
    const state = this.load();
    if (!state) return;
    const now = Date.now();
    if (now >= this.expiresAt(state)) {
      await this.destroy();
      return;
    }
    if (now - this.lastPruneAt >= HOUSEKEEPING_MS) {
      prune(this.sql, now);
      this.lastPruneAt = now;
    }
    if (state.config.demo && this.ctx.getWebSockets().length > 0) this.simulate(now);
    await this.scheduleAlarm();
  }

  private expiresAt(state: QueueState): number {
    const { config } = state;
    return config.demo ? config.createdAt + DEMO_TTL_MS : config.lastActivityAt + QUEUE_IDLE_TTL_MS;
  }

  private async scheduleAlarm(): Promise<void> {
    const state = this.load();
    if (!state) return;
    const now = Date.now();
    let next = Math.min(this.expiresAt(state), now + HOUSEKEEPING_MS);
    if (state.config.demo && this.ctx.getWebSockets().length > 0) {
      next = Math.min(next, now + 3000 + Math.random() * 3000);
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current <= now || next < current) await this.ctx.storage.setAlarm(next);
  }

  private simulate(now: number): void {
    let state = this.load();
    if (!state) return;
    const steps: Command[] = [];
    const arrival = simulatedArrival(state);
    if (arrival) steps.push(arrival);
    for (const command of steps) {
      const outcome = apply(state, command, { now, newId, deviceHash: `sim:${newId()}`, simulated: true });
      if (outcome.ok) {
        this.persist(outcome);
        state = outcome.state;
      }
    }
    if (!state.config.autoServe) return;
    for (const command of simulatedCalls(state, now)) {
      const outcome = apply(state, command, { now, newId });
      if (outcome.ok) {
        this.persist(outcome);
        state = outcome.state;
      }
    }
  }

  /** Delete the queue: tell every screen, then drop all storage. */
  private async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      send(ws, { type: "gone" });
      try {
        ws.close(1000, "expired");
      } catch {
        // Already closed.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.state = null;
  }
}

function fail(code: ErrorCode, message: string): CommandReply {
  return { ok: false, status: STATUS[code], code, message };
}

function send(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Closed.
  }
}
