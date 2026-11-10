import { exports } from "cloudflare:workers";
import type { CommandResult, CreatedQueue, Command, ErrorBody, QueueView, ServerMessage } from "../src/shared/protocol";

const BASE = "https://lineless.test";

let address = 0;
/** A fresh client address per call, so per-address limits don't couple unrelated tests. */
export function newAddress(): string {
  address += 1;
  return `10.0.${Math.floor(address / 250)}.${address % 250}`;
}

export function api(path: string, init: RequestInit & { address?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", init.address ?? newAddress());
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return exports.default.fetch(new Request(BASE + path, { ...init, headers }));
}

export async function createQueue(counters = ["Room 1", "Room 2"]): Promise<CreatedQueue> {
  const response = await api("/api/queues", {
    method: "POST",
    body: JSON.stringify({ name: "Test clinic", counters, serviceMinutes: 5 }),
  });
  if (response.status !== 201) throw new Error(`create failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export async function view(code: string): Promise<QueueView> {
  const response = await api(`/api/q/${code}`);
  if (!response.ok) throw new Error(`view failed: ${response.status}`);
  return response.json();
}

export interface Sent {
  status: number;
  body: CommandResult | ErrorBody;
}

export async function send(
  code: string,
  command: Command,
  options: { staffKey?: string; requestId?: string; address?: string } = {},
): Promise<Sent> {
  const headers: Record<string, string> = {};
  if (options.staffKey) headers.Authorization = `Bearer ${options.staffKey}`;
  const response = await api(`/api/q/${code}/commands`, {
    method: "POST",
    headers,
    address: options.address,
    body: JSON.stringify({ requestId: options.requestId ?? crypto.randomUUID(), command }),
  });
  return { status: response.status, body: await response.json() };
}

export function device(): string {
  return crypto.randomUUID();
}

export async function joinAs(code: string, deviceId = device(), name = ""): Promise<{ id: string; number: number }> {
  const sent = await send(code, { type: "join", device: deviceId, name });
  if (sent.status !== 200 || !("type" in sent.body) || sent.body.type !== "joined") {
    throw new Error(`join failed: ${JSON.stringify(sent)}`);
  }
  return sent.body.ticket;
}

/** A WebSocket client that records every message. */
export class Socket {
  readonly messages: ServerMessage[] = [];
  private waiters: (() => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      this.messages.push(JSON.parse(event.data as string) as ServerMessage);
      for (const wake of this.waiters.splice(0)) wake();
    });
    ws.accept();
  }

  static async open(code: string): Promise<Socket> {
    const response = await api(`/api/q/${code}/ws`, { headers: { Upgrade: "websocket" } });
    if (!response.webSocket) throw new Error(`no websocket: ${response.status}`);
    return new Socket(response.webSocket);
  }

  hello(message: { staffKey?: string; ticket?: { id: string; device: string } }): void {
    this.ws.send(JSON.stringify({ type: "hello", ...message }));
  }

  /** Wait for a message matching `predicate`, looking at ones already received first. */
  async next(predicate: (m: ServerMessage) => boolean, timeoutMs = 2_000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    for (;;) {
      const found = this.messages.slice(seen).find(predicate);
      if (found) return found;
      seen = this.messages.length;
      if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(this.messages.at(-1))}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  latest(): ServerMessage | undefined {
    return this.messages.at(-1);
  }

  close(): void {
    this.ws.close(1000, "done");
  }
}
