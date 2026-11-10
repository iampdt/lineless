import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QueueObject } from "../src/worker/queue-object";
import type { CommandResult, ServerMessage, StaffView } from "../src/shared/protocol";
import { api, createQueue, device, joinAs, newAddress, send, Socket, view } from "./helpers";

function stub(code: string) {
  return env.QUEUES.get(env.QUEUES.idFromName(code));
}

function called(result: unknown): number | null {
  const r = result as CommandResult;
  if (r.type !== "called") throw new Error(`not a call: ${JSON.stringify(result)}`);
  return r.ticket?.number ?? null;
}

describe("creating a queue", () => {
  it("returns a code and a staff key, and the queue is open", async () => {
    const { code, staffKey } = await createQueue();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(staffKey.length).toBeGreaterThanOrEqual(40);
    const queue = await view(code);
    expect(queue).toMatchObject({ code, name: "Test clinic", status: "open", waiting: [] });
    expect(queue.counters.map((c) => c.name)).toEqual(["Room 1", "Room 2"]);
  });

  it("rejects bad input", async () => {
    const response = await api("/api/queues", { method: "POST", body: JSON.stringify({ name: "", counters: [] }) });
    expect(response.status).toBe(400);
  });

  it("limits how many queues one address creates", async () => {
    const address = newAddress();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await api("/api/queues", {
        method: "POST",
        address,
        body: JSON.stringify({ name: "Spam", counters: ["A"], serviceMinutes: 5 }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("answers 404 for a code that doesn't exist, without creating storage", async () => {
    const response = await api("/api/q/ZZZZZZ");
    expect(response.status).toBe(404);
    const exists = await runInDurableObject(stub("ZZZZZZ"), (_instance: QueueObject, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray(),
    );
    expect(exists).toEqual([]);
  });
});

describe("staff commands", () => {
  it("need the staff key", async () => {
    const { code } = await createQueue();
    const queue = await view(code);
    const command = { type: "call_next", counterId: queue.counters[0]!.id, expectServing: null } as const;
    expect((await send(code, command)).status).toBe(401);
    expect((await send(code, command, { staffKey: "wrong" })).status).toBe(401);
  });
});

describe("adding someone without a phone", () => {
  it("gives them the next number, for staff only", async () => {
    const { code, staffKey } = await createQueue();
    await joinAs(code);
    expect((await send(code, { type: "add_ticket", name: "Mrs Rao" })).status).toBe(401);
    const added = await send(code, { type: "add_ticket", name: "Mrs Rao" }, { staffKey });
    expect(added.body).toMatchObject({ type: "joined", ticket: { number: 2 }, existing: false });
    // Staff can still add people while joining is paused.
    await send(code, { type: "set_status", status: "paused" }, { staffKey });
    expect((await send(code, { type: "add_ticket" }, { staffKey })).status).toBe(200);
    expect((await view(code)).waiting).toEqual([1, 2, 3]);
  });
});

describe("joining", () => {
  it("is idempotent per device and per request id", async () => {
    const { code } = await createQueue();
    const me = device();
    const requestId = crypto.randomUUID();
    const first = await send(code, { type: "join", device: me }, { requestId });
    const retry = await send(code, { type: "join", device: me }, { requestId });
    const again = await send(code, { type: "join", device: me });
    expect(retry.body).toEqual(first.body);
    expect(again.body).toMatchObject({ type: "joined", existing: true });
    expect((await view(code)).waiting).toEqual([1]);
  });

  it("refuses a request id reused for a different command", async () => {
    const { code } = await createQueue();
    const requestId = crypto.randomUUID();
    await send(code, { type: "join", device: device() }, { requestId });
    const reused = await send(code, { type: "join", device: device() }, { requestId });
    expect(reused.status).toBe(422);
  });

  it("limits joins from one address", async () => {
    const { code } = await createQueue();
    const address = newAddress();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await send(code, { type: "join", device: device() }, { address })).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(30);
    expect(statuses[30]).toBe(429);
  });
});

describe("calling under concurrency", () => {
  it("calls everyone exactly once when three counters race", async () => {
    const { code, staffKey } = await createQueue(["A", "B", "C"]);
    await Promise.all(Array.from({ length: 30 }, () => joinAs(code)));
    const { counters } = await view(code);

    // Each counter keeps calling until the line is empty, all at once.
    const calledNumbers: number[] = [];
    await Promise.all(
      counters.map(async (counter) => {
        let expectServing: string | null = null;
        for (;;) {
          const sent = await send(code, { type: "call_next", counterId: counter.id, expectServing }, { staffKey });
          expect(sent.status).toBe(200);
          const result = sent.body as CommandResult;
          if (result.type !== "called" || result.ticket === null) return;
          calledNumbers.push(result.ticket.number);
          expectServing = result.ticket.id;
        }
      }),
    );

    expect(calledNumbers).toHaveLength(30);
    expect(new Set(calledNumbers).size).toBe(30);
    expect([...calledNumbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    // The queue serialised the calls, so numbers went out in order.
    expect(calledNumbers).toEqual([...calledNumbers].sort((a, b) => a - b));
  });

  it("lets only one of two simultaneous clicks on the same counter through", async () => {
    const { code, staffKey } = await createQueue();
    for (let i = 0; i < 3; i++) await joinAs(code);
    const counter = (await view(code)).counters[0]!;
    const command = { type: "call_next", counterId: counter.id, expectServing: null } as const;
    const [a, b] = await Promise.all([send(code, command, { staffKey }), send(code, command, { staffKey })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const queue = await view(code);
    expect(queue.counters[0]!.serving).toBe(1);
    expect(queue.waiting).toEqual([2, 3]);
  });

  it("answers a retried call from the first attempt instead of calling the next person", async () => {
    const { code, staffKey } = await createQueue();
    for (let i = 0; i < 3; i++) await joinAs(code);
    const counter = (await view(code)).counters[0]!;
    const requestId = crypto.randomUUID();
    const command = { type: "call_next", counterId: counter.id, expectServing: null } as const;
    const first = await send(code, command, { staffKey, requestId });
    const retry = await send(code, command, { staffKey, requestId });
    expect(called(first.body)).toBe(1);
    expect(retry.body).toEqual(first.body);
    expect((await view(code)).waiting).toEqual([2, 3]);
  });
});

describe("live updates", () => {
  it("pushes every change to connected screens", async () => {
    const { code, staffKey } = await createQueue();
    const screen = await Socket.open(code);
    const initial = await screen.next((m) => m.type === "state");
    const version = initial.type === "state" ? initial.queue.version : 0;

    await joinAs(code);
    const update = await screen.next((m) => m.type === "state" && m.queue.version > version);
    expect(update.type === "state" && update.queue.waiting).toEqual([1]);

    const counter = (await view(code)).counters[0]!;
    await send(code, { type: "call_next", counterId: counter.id, expectServing: null }, { staffKey });
    const after = await screen.next((m) => m.type === "state" && m.queue.counters[0]!.serving === 1);
    expect(after.type === "state" && after.queue.waiting).toEqual([]);
    screen.close();
  });

  it("gives staff the full list and customers only their own ticket, never names", async () => {
    const { code, staffKey } = await createQueue();
    const me = device();
    const ticket = await joinAs(code, me, "Priya Sharma");
    await joinAs(code, device(), "Arjun Rao");

    const staff = await Socket.open(code);
    staff.hello({ staffKey });
    const staffState = await staff.next((m) => m.type === "state" && m.staff !== undefined);
    const names = (staffState as { staff: StaffView }).staff.waiting.map((t) => t.name);
    expect(names).toEqual(["Priya Sharma", "Arjun Rao"]);

    const customer = await Socket.open(code);
    customer.hello({ ticket: { id: ticket.id, device: me } });
    const mine = await customer.next((m) => m.type === "state" && m.you !== undefined);
    expect(mine.type === "state" && mine.you).toMatchObject({ number: 1, status: "waiting", position: 1 });
    expect(customer.messages.map((m) => JSON.stringify(m)).join("")).not.toMatch(/Priya|Arjun/);

    const intruder = await Socket.open(code);
    intruder.hello({ ticket: { id: ticket.id, device: device() } });
    expect(await intruder.next((m) => m.type === "denied")).toEqual({ type: "denied", reason: "unknown_ticket" });
    const badStaff = await Socket.open(code);
    badStaff.hello({ staffKey: "guess" });
    expect(await badStaff.next((m) => m.type === "denied")).toEqual({ type: "denied", reason: "bad_key" });
    for (const s of [staff, customer, intruder, badStaff]) s.close();
  });

  it("tells a customer when they're called, and where to go", async () => {
    const { code, staffKey } = await createQueue();
    const me = device();
    const ticket = await joinAs(code, me);
    const phone = await Socket.open(code);
    phone.hello({ ticket: { id: ticket.id, device: me } });
    await phone.next((m) => m.type === "state" && m.you?.status === "waiting");
    const counter = (await view(code)).counters[1]!;
    await send(code, { type: "call_next", counterId: counter.id, expectServing: null }, { staffKey });
    const turn = (await phone.next((m) => m.type === "state" && m.you?.status === "called")) as Extract<
      ServerMessage,
      { type: "state" }
    >;
    expect(turn.you).toMatchObject({ status: "called", counterName: "Room 2" });
    phone.close();
  });
});

describe("the staff report", () => {
  it("needs the staff key, and has every ticket without names", async () => {
    const { code, staffKey } = await createQueue();
    await joinAs(code, device(), "Priya Sharma");
    await joinAs(code, device(), "Arjun Rao");
    const counter = (await view(code)).counters[0]!;
    await send(code, { type: "call_next", counterId: counter.id, expectServing: null }, { staffKey });

    expect((await api(`/api/q/${code}/report`)).status).toBe(401);
    const response = await api(`/api/q/${code}/report`, { headers: { Authorization: `Bearer ${staffKey}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    const csv = await response.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("number,status,counter,joined_at,called_at,finished_at,waited_minutes,shown_minutes,within_range,simulated");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^"1","called","Room 1",/);
    expect(lines[1]).toContain('"yes"'); // called at once, as shown
    expect(csv).not.toMatch(/Priya|Arjun/);
  });
});

describe("durability", () => {
  it("keeps the queue when its object is evicted from memory", async () => {
    const { code, staffKey } = await createQueue();
    for (let i = 0; i < 3; i++) await joinAs(code);
    const counter = (await view(code)).counters[0]!;
    await send(code, { type: "call_next", counterId: counter.id, expectServing: null }, { staffKey });
    const before = await view(code);

    await evictDurableObject(stub(code));

    const after = await view(code);
    expect({ ...after, serverTime: 0 }).toEqual({ ...before, serverTime: 0 });
    // And it keeps working: the next call continues from where it was.
    const next = await send(
      code,
      { type: "call_next", counterId: counter.id, expectServing: null },
      { staffKey },
    );
    expect(next.status).toBe(409); // the screen's view (null) is stale: ticket 1 is at the counter
  });

  it("upgrades a queue stored by the previous version", async () => {
    const { code, staffKey } = await createQueue();
    await joinAs(code);
    // Make it look like the version before estimates were recorded.
    await runInDurableObject(stub(code), (_instance: QueueObject, state) => {
      const sql = state.storage.sql;
      sql.exec("ALTER TABLE tickets DROP COLUMN estimate_seconds");
      const config = JSON.parse(sql.exec<{ config: string }>("SELECT config FROM queue").one().config);
      delete config.totals;
      delete config.session.estimates;
      sql.exec("UPDATE queue SET config = ?", JSON.stringify(config));
    });
    await evictDurableObject(stub(code));

    await joinAs(code);
    const counter = (await view(code)).counters[0]!;
    const sent = await send(code, { type: "call_next", counterId: counter.id, expectServing: null }, { staffKey });
    expect(sent.status).toBe(200);
    expect((await view(code)).waiting).toEqual([2]);
    const report = await api(`/api/q/${code}/report`, { headers: { Authorization: `Bearer ${staffKey}` } });
    expect((await report.text()).trim().split("\r\n")).toHaveLength(3);
  });

  it("deletes a queue after a month without activity", async () => {
    const { code } = await createQueue();
    await runInDurableObject(stub(code), (_instance: QueueObject, state) => {
      const row = state.storage.sql.exec<{ config: string }>("SELECT config FROM queue").one();
      const config = JSON.parse(row.config);
      config.lastActivityAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
      state.storage.sql.exec("UPDATE queue SET config = ?", JSON.stringify(config));
    });
    await evictDurableObject(stub(code)); // drop the cached copy so the alarm reads storage
    expect(await runDurableObjectAlarm(stub(code))).toBe(true);
    expect((await api(`/api/q/${code}`)).status).toBe(404);
  });
});

describe("the demo", () => {
  it("starts with both rooms busy and people waiting", async () => {
    const response = await api("/api/demo", { method: "POST" });
    expect(response.status).toBe(201);
    const { code } = (await response.json()) as { code: string };
    const queue = await view(code);
    expect(queue.demo).toBe(true);
    expect(queue.counters.map((c) => c.serving)).toEqual([1, 2]);
    expect(queue.waiting).toEqual([3, 4, 5]);
  });

  it("serves people on its own when auto-serve is on and someone is watching", async () => {
    const response = await api("/api/demo", { method: "POST" });
    const { code, staffKey } = (await response.json()) as { code: string; staffKey: string };
    expect((await send(code, { type: "set_auto_serve", on: true }, { staffKey })).status).toBe(200);
    const screen = await Socket.open(code);
    await screen.next((m) => m.type === "state");
    expect(await runDurableObjectAlarm(stub(code))).toBe(true);
    const queue = await view(code);
    // The seeded calls are a minute or two old, so both rooms move on.
    expect(queue.counters.map((c) => c.serving)).toEqual([3, 4]);
    screen.close();
  });

  it("refuses auto-serve outside the demo", async () => {
    const { code, staffKey } = await createQueue();
    expect((await send(code, { type: "set_auto_serve", on: true }, { staffKey })).status).toBe(400);
  });
});
