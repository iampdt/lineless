// How long does "Call next" take to reach every screen watching a queue?
//
// Opens N WebSocket connections to one new queue, then presses "Call next" M times and measures,
// for each press, the time from sending the command to each socket receiving the new state.
// All clocks are this machine's, so no clock sync is involved.
//
//   npm run loadtest -- --url http://localhost:5173 --sockets 500 --calls 20
//   npm run loadtest -- --url https://lineless.<account>.workers.dev --sockets 1000 --calls 20

import WebSocket from "ws";
import type { CreatedQueue, QueueView, ServerMessage } from "../src/shared/protocol";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const BASE = arg("url", "http://localhost:5173").replace(/\/$/, "");
const SOCKETS = Number(arg("sockets", "500"));
const CALLS = Number(arg("calls", "20"));
const CONNECT_CONCURRENCY = 50;

async function post<T>(path: string, body: unknown, key?: string): Promise<T> {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const ms = (n: number) => `${n.toFixed(0)} ms`;

interface Watcher {
  socket: WebSocket;
  /** Serving number at the first counter, as last seen. */
  serving: number | null;
  onState?: (queue: QueueView) => void;
  bytes: number;
}

async function main() {
  console.log(`Target ${BASE}: ${SOCKETS} sockets, ${CALLS} calls\n`);
  const { code, staffKey } = await post<CreatedQueue>("/api/queues", {
    name: "Load test",
    counters: ["Desk"],
    serviceMinutes: 5,
  });
  for (let i = 0; i < CALLS; i++) {
    await post("/api/q/" + code + "/commands", {
      requestId: crypto.randomUUID(),
      command: { type: "join", device: crypto.randomUUID() },
    });
  }
  const wsUrl = BASE.replace(/^http/, "ws") + `/api/q/${code}/ws`;

  // Connect in batches, timing each handshake to the first state message.
  const watchers: Watcher[] = [];
  const connectTimes: number[] = [];
  let failures = 0;
  for (let start = 0; start < SOCKETS; start += CONNECT_CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONNECT_CONCURRENCY, SOCKETS - start) }, () =>
      new Promise<void>((resolve) => {
        const began = performance.now();
        const socket = new WebSocket(wsUrl);
        const watcher: Watcher = { socket, serving: null, bytes: 0 };
        let first = true;
        socket.on("message", (data) => {
          const text = data.toString();
          watcher.bytes = text.length;
          const message = JSON.parse(text) as ServerMessage;
          if (message.type !== "state") return;
          watcher.serving = message.queue.counters[0]?.serving ?? null;
          watcher.onState?.(message.queue);
          if (first) {
            first = false;
            connectTimes.push(performance.now() - began);
            watchers.push(watcher);
            resolve();
          }
        });
        socket.on("error", () => {
          failures += 1;
          resolve();
        });
      }),
    );
    await Promise.all(batch);
  }
  console.log(`Connected ${watchers.length}/${SOCKETS} (failed ${failures})`);
  console.log(`Connect to first state: p50 ${ms(quantile(connectTimes, 0.5))}, p95 ${ms(quantile(connectTimes, 0.95))}\n`);

  const queue = await (await fetch(`${BASE}/api/q/${code}`)).json() as QueueView;
  const counterId = queue.counters[0]!.id;
  let expectServing: string | null = null;
  const commandTimes: number[] = [];
  const delivery: number[] = [];
  const lastDelivery: number[] = [];
  let missed = 0;

  for (let call = 1; call <= CALLS; call++) {
    const target = call; // tickets are numbered from 1 and called in order
    const arrivals: number[] = [];
    const began = performance.now();
    const allSeen = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      let pending = watchers.length;
      for (const watcher of watchers) {
        watcher.onState = (q) => {
          if (q.counters[0]?.serving === target) {
            watcher.onState = undefined;
            arrivals.push(performance.now() - began);
            if (--pending === 0) {
              clearTimeout(timer);
              resolve();
            }
          }
        };
      }
    });
    const result: { type: string; ticket: { id: string; number: number } | null } = await post(
      `/api/q/${code}/commands`,
      { requestId: crypto.randomUUID(), command: { type: "call_next", counterId, expectServing } },
      staffKey,
    );
    commandTimes.push(performance.now() - began);
    expectServing = result.ticket?.id ?? null;
    await allSeen;
    missed += watchers.length - arrivals.length;
    delivery.push(...arrivals);
    lastDelivery.push(Math.max(...arrivals));
    await new Promise((r) => setTimeout(r, 250));
  }

  const size = watchers[0]?.bytes ?? 0;
  console.log(`"Call next" round trip:           p50 ${ms(quantile(commandTimes, 0.5))}, p95 ${ms(quantile(commandTimes, 0.95))}`);
  console.log(
    `Command sent → screen updated:    p50 ${ms(quantile(delivery, 0.5))}, p95 ${ms(quantile(delivery, 0.95))}, p99 ${ms(quantile(delivery, 0.99))}`,
  );
  console.log(`Command sent → last screen:       p50 ${ms(quantile(lastDelivery, 0.5))}, max ${ms(Math.max(...lastDelivery))}`);
  console.log(`Deliveries: ${delivery.length} of ${CALLS * watchers.length} (missed ${missed}); message ${size} bytes`);

  for (const watcher of watchers) watcher.socket.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
