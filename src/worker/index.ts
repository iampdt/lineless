// The Worker in front of everything. Static files (the web app) are served by the platform;
// requests under /api/ come here, are validated, and go to the right queue's Durable Object.

import { z } from "zod";
import { DEMO_QUEUE } from "./demo";
import { CODE_PATTERN, newCode, newSecret, sha256 } from "./ids";
import { type CreatedQueue, type ErrorCode, LIMITS } from "../shared/protocol";

export { QueueObject } from "./queue-object";
export { RateLimiter } from "./rate-limiter";

const HOUR = 60 * 60 * 1000;
/** Creations per client address per hour. */
export const CREATE_LIMITS = { queue: 10, demo: 30 };
const MAX_BODY_BYTES = 8 * 1024;

const name = (max: number) => z.string().trim().min(1).max(max);

const createSchema = z.object({
  name: name(LIMITS.queueName),
  counters: z.array(name(LIMITS.counterName)).min(1).max(LIMITS.counters),
  serviceMinutes: z.number().int().min(LIMITS.serviceMinutes.min).max(LIMITS.serviceMinutes.max),
});

const id = z.string().min(1).max(64);
const device = z.string().min(16).max(64);

const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), device, name: z.string().max(200).optional() }),
  z.object({ type: z.literal("add_ticket"), name: z.string().max(200).optional() }),
  z.object({ type: z.literal("leave"), ticketId: id, device }),
  z.object({ type: z.literal("call_next"), counterId: id, expectServing: id.nullable() }),
  z.object({ type: z.literal("recall"), ticketId: id }),
  z.object({ type: z.literal("finish"), ticketId: id }),
  z.object({ type: z.literal("no_show"), ticketId: id }),
  z.object({ type: z.literal("bring_back"), ticketId: id }),
  z.object({ type: z.literal("set_status"), status: z.enum(["open", "paused", "closed"]) }),
  z.object({ type: z.literal("clear_waiting") }),
  z.object({
    type: z.literal("set_counters"),
    counters: z.array(z.object({ id: id.nullable(), name: z.string().max(200) })).min(1).max(LIMITS.counters),
  }),
  z.object({ type: z.literal("set_auto_serve"), on: z.boolean() }),
]);

const requestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  command: commandSchema,
});

const QUEUE_ROUTE = /^\/api\/q\/([^/]+)(\/commands|\/ws|\/report)?$/;

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("unhandled", error);
      return problem(500, "internal", "Something went wrong on our side.");
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/health" && method === "GET") return json({ ok: true });
  if (pathname === "/api/queues" && method === "POST") return createQueue(request, env, false);
  if (pathname === "/api/demo" && method === "POST") return createQueue(request, env, true);

  const match = QUEUE_ROUTE.exec(pathname);
  if (!match) return problem(404, "not_found", "No such endpoint.");
  const code = (match[1] ?? "").toUpperCase();
  if (!CODE_PATTERN.test(code)) return problem(404, "not_found", "There's no line with that code.");
  const queue = env.QUEUES.get(env.QUEUES.idFromName(code));

  switch (match[2]) {
    case undefined: {
      if (method !== "GET") return problem(405, "invalid", "Use GET.");
      const view = await queue.view();
      return view ? json(view) : problem(404, "not_found", "There's no line with that code. It may have expired.");
    }
    case "/ws": {
      if (request.headers.get("Upgrade") !== "websocket") return problem(426, "invalid", "Expected a WebSocket.");
      return queue.fetch(request);
    }
    case "/report": {
      if (method !== "GET") return problem(405, "invalid", "Use GET.");
      const report = await queue.report(bearer(request));
      if (!report.ok) return problem(report.status, report.code, report.code === "unauthorized" ? "This needs the staff link." : "There's no line with that code.");
      return new Response(report.csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="lineless-${code}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    case "/commands": {
      if (method !== "POST") return problem(405, "invalid", "Use POST.");
      const body = await readJson(request);
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) return problem(400, "invalid", describe(parsed.error));
      const reply = await queue.run(parsed.data, bearer(request), clientAddress(request));
      return reply.ok ? json(reply.result) : problem(reply.status, reply.code, reply.message);
    }
    default:
      return problem(404, "not_found", "No such endpoint.");
  }
}

async function createQueue(request: Request, env: Env, demo: boolean): Promise<Response> {
  const limiter = env.LIMITERS.get(
    env.LIMITERS.idFromName(`${demo ? "demo" : "queue"}:${await sha256(clientAddress(request))}`),
  );
  const limit = await limiter.hit(demo ? CREATE_LIMITS.demo : CREATE_LIMITS.queue, HOUR);
  if (!limit.allowed) {
    return problem(429, "rate_limited", "Too many new lines from this network. Try again later.", {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  let input = DEMO_QUEUE;
  if (!demo) {
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) return problem(400, "invalid", describe(parsed.error));
    input = parsed.data;
  }

  const staffKey = newSecret();
  const staffKeyHash = await sha256(staffKey);
  // A new code is free with near certainty; the object refuses if one already holds a queue.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const queue = env.QUEUES.get(env.QUEUES.idFromName(code));
    if (await queue.create({ ...input, code, demo, staffKeyHash })) {
      return json({ code, staffKey } satisfies CreatedQueue, 201);
    }
  }
  return problem(500, "internal", "Couldn't find a free code. Try again.");
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

function clientAddress(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "local";
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request.";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function problem(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
