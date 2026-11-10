// Commands over HTTP. Each command gets a request id once, and every retry reuses it: if the
// first attempt reached the queue and only the answer was lost, the retry gets that answer
// instead of doing the thing twice.

import type { Command, CommandResult, CreatedQueue, ErrorBody, ErrorCode } from "../../shared/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network",
    message: string,
  ) {
    super(message);
  }
}

const RETRIES = 3;

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(300 * 2 ** (attempt - 1) + Math.random() * 200);
    let response: Response;
    try {
      response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = error; // Network failure: the request may or may not have arrived. Retry.
      continue;
    }
    if (response.ok) return (await response.json()) as T;
    if (response.status >= 500 && attempt < RETRIES) continue;
    const payload = (await response.json().catch(() => null)) as ErrorBody | null;
    throw new ApiError(response.status, payload?.error.code ?? "internal", payload?.error.message ?? "Something went wrong.");
  }
  throw new ApiError(0, "network", lastError instanceof Error ? "You seem to be offline. Try again." : "Network error.");
}

export function sendCommand(code: string, command: Command, staffKey?: string | null): Promise<CommandResult> {
  const headers: Record<string, string> = staffKey ? { Authorization: `Bearer ${staffKey}` } : {};
  return post<CommandResult>(`/api/q/${code}/commands`, { requestId: crypto.randomUUID(), command }, headers);
}

export function createQueue(input: { name: string; counters: string[]; serviceMinutes: number }): Promise<CreatedQueue> {
  return post<CreatedQueue>("/api/queues", input);
}

export function createDemo(): Promise<CreatedQueue> {
  return post<CreatedQueue>("/api/demo", {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Download the staff report (CSV, no names) through the browser. */
export async function downloadReport(code: string, staffKey: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/q/${code}/report`, { headers: { Authorization: `Bearer ${staffKey}` } });
  } catch {
    throw new ApiError(0, "network", "You seem to be offline. Try again.");
  }
  if (!response.ok) throw new ApiError(response.status, "internal", "Couldn't get the report. Try again.");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `lineless-${code}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
