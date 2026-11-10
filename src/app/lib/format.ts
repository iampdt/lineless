import { type Pace, waitRange } from "../../shared/estimate";

/**
 * "about 6–12 min", "under a minute", "about 1–2 hours". `receivedAt` is when the pace arrived,
 * so the estimate counts down between updates.
 */
export function formatWait(position: number, pace: Pace, receivedAt: number, now = Date.now()): string {
  const { low, high } = waitRange(position, pace, Math.max(0, (now - receivedAt) / 1000));
  if (high < 60) return "under a minute";
  const lo = Math.max(1, Math.round(low / 60));
  const hi = Math.max(lo + 1, Math.round(high / 60));
  if (hi < 90) return `about ${lo}–${hi} min`;
  return `about ${Math.round((lo / 60) * 2) / 2}–${Math.round((hi / 60) * 2) / 2} hours`;
}

/** "just now", "4 min", "1 h 5 min". */
export function since(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** "just now", "4 min ago". */
export function ago(timestamp: number, now: number): string {
  const text = since(timestamp, now);
  return text === "just now" ? text : `${text} ago`;
}

export function seconds(value: number | null): string {
  if (value === null) return "—";
  if (value < 60) return `${value} s`;
  const minutes = Math.round(value / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function joinUrl(code: string): string {
  return `${location.origin}/q/${code}`;
}
