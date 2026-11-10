// Turning the queue's pace into the wait a customer sees. The range is deliberately wider above
// the middle than below it: arriving a little early costs less than missing your turn. The
// multipliers come from the simulation in scripts/simulate-waits.ts (docs/results.md).

export const RANGE_LOW = 0.5;
export const RANGE_HIGH = 1.5;

/** How fast the line moves right now, as sent to every screen. */
export interface Pace {
  /** Seconds between calls while every working counter is busy. */
  secondsPerTicket: number;
  /** Working counters that are free: that many people are called almost at once. */
  free: number;
  /** Seconds until the first busy counter is expected to finish. */
  nextFreeIn: number;
}

export interface WaitRange {
  /** Seconds. */
  low: number;
  high: number;
}

/**
 * Expected seconds until the person at `position` (1 = next) is called. `elapsed` is how long
 * ago the pace was computed, so a countdown keeps moving between updates.
 */
export function expectedWait(position: number, pace: Pace, elapsed = 0): number {
  if (position <= pace.free) return 0;
  const first = Math.max(0, pace.nextFreeIn - elapsed);
  return first + (position - pace.free - 1) * pace.secondsPerTicket;
}

export function waitRange(position: number, pace: Pace, elapsed = 0): WaitRange {
  const middle = expectedWait(position, pace, elapsed);
  return { low: middle * RANGE_LOW, high: middle * RANGE_HIGH };
}
