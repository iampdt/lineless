// The staff report: one row per stored ticket, as CSV, for writing up how a line went. No names
// and no device hashes: the report can be shared without exposing anyone who waited.

import type { Counter } from "../domain/model";
import { withinRange } from "../shared/estimate";
import type { ReportRow } from "./storage";

const COLUMNS = [
  "number",
  "status",
  "counter",
  "joined_at",
  "called_at",
  "finished_at",
  "waited_minutes",
  "shown_minutes",
  "within_range",
  "simulated",
];

export function reportCsv(rows: ReportRow[], counters: Counter[]): string {
  const names = new Map(counters.map((c) => [c.id, c.name]));
  const lines = [COLUMNS.join(",")];
  for (const row of rows) {
    const waited = row.called_at !== null ? (row.called_at - row.joined_at) / 1000 : null;
    const scored = waited !== null && row.estimate_seconds !== null;
    lines.push(
      [
        row.number,
        row.status,
        row.counter_id ? (names.get(row.counter_id) ?? "removed counter") : "",
        iso(row.joined_at),
        iso(row.called_at),
        iso(row.finished_at),
        waited !== null ? (waited / 60).toFixed(1) : "",
        row.estimate_seconds !== null ? (row.estimate_seconds / 60).toFixed(1) : "",
        scored ? (withinRange(row.estimate_seconds ?? 0, waited ?? 0) ? "yes" : "no") : "",
        row.simulated ? "yes" : "no",
      ]
        .map(cell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function iso(timestamp: number | null): string {
  return timestamp === null ? "" : new Date(timestamp).toISOString();
}

/** Quote every cell, and defuse anything a spreadsheet would run as a formula. */
function cell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
