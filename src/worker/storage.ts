// A queue's SQLite database inside its Durable Object. The queue row holds the configuration as
// JSON; tickets are rows so finished ones can be pruned; requests remember answers to command
// ids for a day; events are an append-only log of what happened.

import type { QueueEvent } from "../domain/queue";
import { type QueueConfig, type QueueState, RECENT_MS, type Ticket } from "../domain/model";
import type { CommandResult, TicketStatus } from "../shared/protocol";

const DAY = 24 * 60 * 60 * 1000;
/** Answers to command ids are kept this long; a retry after that is a new request. */
export const REQUEST_TTL_MS = DAY;
/** Finished tickets, with the names on them, are deleted after this. */
export const TICKET_TTL_MS = 7 * DAY;
export const EVENT_TTL_MS = 30 * DAY;

export function exists(sql: SqlStorage): boolean {
  return sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'queue'").toArray().length > 0;
}

export function migrate(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL)");
  sql.exec(`CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    number INTEGER NOT NULL,
    name TEXT NOT NULL,
    device_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    counter_id TEXT,
    sort INTEGER NOT NULL,
    joined_at INTEGER NOT NULL,
    called_at INTEGER,
    finished_at INTEGER,
    recalls INTEGER NOT NULL,
    simulated INTEGER NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS tickets_by_status ON tickets (status, finished_at)");
  sql.exec(`CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    result TEXT NOT NULL,
    at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    ticket_id TEXT,
    counter_id TEXT
  )`);
}

/** The working set: configuration, tickets in play, and tickets finished recently. */
export function readState(sql: SqlStorage, now: number): QueueState | null {
  if (!exists(sql)) return null;
  const row = sql.exec<{ config: string }>("SELECT config FROM queue WHERE id = 1").toArray()[0];
  if (!row) return null;
  const config = JSON.parse(row.config) as QueueConfig;
  const rows = sql
    .exec<TicketRow>(
      "SELECT * FROM tickets WHERE status IN ('waiting', 'called') OR finished_at > ?",
      now - RECENT_MS,
    )
    .toArray();
  return { config, tickets: new Map(rows.map((r) => [r.id, fromRow(r)])) };
}

/** A ticket outside the working set, for a customer reconnecting long after being served. */
export function readTicket(sql: SqlStorage, id: string): Ticket | null {
  const row = sql.exec<TicketRow>("SELECT * FROM tickets WHERE id = ?", id).toArray()[0];
  return row ? fromRow(row) : null;
}

export function saveConfig(sql: SqlStorage, config: QueueConfig): void {
  sql.exec(
    "INSERT INTO queue (id, config) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET config = excluded.config",
    JSON.stringify(config),
  );
}

export function saveTickets(sql: SqlStorage, tickets: Ticket[]): void {
  for (const t of tickets) {
    sql.exec(
      `INSERT INTO tickets (id, number, name, device_hash, status, counter_id, sort, joined_at, called_at,
         finished_at, recalls, simulated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, counter_id = excluded.counter_id,
         sort = excluded.sort, called_at = excluded.called_at, finished_at = excluded.finished_at,
         recalls = excluded.recalls`,
      t.id,
      t.number,
      t.name,
      t.deviceHash,
      t.status,
      t.counterId,
      t.order,
      t.joinedAt,
      t.calledAt,
      t.finishedAt,
      t.recalls,
      t.simulated ? 1 : 0,
    );
  }
}

export function saveEvents(sql: SqlStorage, events: QueueEvent[], now: number): void {
  for (const e of events) {
    sql.exec("INSERT INTO events (at, type, ticket_id, counter_id) VALUES (?, ?, ?, ?)", now, e.type, e.ticketId, e.counterId);
  }
}

export interface StoredRequest {
  fingerprint: string;
  result: CommandResult;
}

export function readRequest(sql: SqlStorage, id: string, now: number): StoredRequest | null {
  const row = sql
    .exec<{ fingerprint: string; result: string }>(
      "SELECT fingerprint, result FROM requests WHERE id = ? AND at > ?",
      id,
      now - REQUEST_TTL_MS,
    )
    .toArray()[0];
  return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result) as CommandResult } : null;
}

export function saveRequest(sql: SqlStorage, id: string, fingerprint: string, result: CommandResult, now: number): void {
  sql.exec(
    "INSERT OR REPLACE INTO requests (id, fingerprint, result, at) VALUES (?, ?, ?, ?)",
    id,
    fingerprint,
    JSON.stringify(result),
    now,
  );
}

export function prune(sql: SqlStorage, now: number): void {
  sql.exec("DELETE FROM requests WHERE at <= ?", now - REQUEST_TTL_MS);
  sql.exec("DELETE FROM tickets WHERE finished_at IS NOT NULL AND finished_at <= ?", now - TICKET_TTL_MS);
  sql.exec("DELETE FROM events WHERE at <= ?", now - EVENT_TTL_MS);
}

type TicketRow = {
  id: string;
  number: number;
  name: string;
  device_hash: string;
  status: TicketStatus;
  counter_id: string | null;
  sort: number;
  joined_at: number;
  called_at: number | null;
  finished_at: number | null;
  recalls: number;
  simulated: number;
};

function fromRow(r: TicketRow): Ticket {
  return {
    id: r.id,
    number: r.number,
    name: r.name,
    deviceHash: r.device_hash,
    status: r.status,
    counterId: r.counter_id,
    order: r.sort,
    joinedAt: r.joined_at,
    calledAt: r.called_at,
    finishedAt: r.finished_at,
    recalls: r.recalls,
    simulated: r.simulated === 1,
  };
}
