// How long one person takes at a counter, learned from the queue itself.
//
// Each finished service is a sample: from the call to the moment the counter moved on. The
// average starts at the host's guess and moves toward what actually happens, quickly at first
// (a running mean while there are few samples) and then as an exponentially weighted average,
// so it follows a slow afternoon without forgetting the morning entirely.
//
// One trap: staff press "Call next" when they're ready, not when the last person left. If the
// line ran empty during a service, the counter may have sat idle before that press, and the
// sample would count idle time as service time. Those samples are dropped.

import type { Pace } from "../shared/estimate";
import type { Counter } from "./model";

export interface EstimatorState {
  /** Current estimate of one service, in seconds. */
  serviceSeconds: number;
  samples: number;
  /** When the line last ran empty, or 0. */
  lastEmptyAt: number;
  /** True while nobody is waiting. */
  empty: boolean;
}

export interface EstimatorOptions {
  /** Weight of a new sample once there are enough of them. 0 keeps the host's guess forever. */
  alpha: number;
  /** Drop samples taken while the line was empty at some point (see above). */
  dropIdleSamples: boolean;
}

export const DEFAULT_ESTIMATOR: EstimatorOptions = { alpha: 0.2, dropIdleSamples: true };

const MIN_SAMPLE_SECONDS = 5;
/** A sample this many times the estimate is clamped: a counter that went to lunch isn't data. */
const MAX_SAMPLE_FACTOR = 4;

export function initialEstimator(serviceSeconds: number, now: number): EstimatorState {
  return { serviceSeconds, samples: 0, lastEmptyAt: now, empty: true };
}

/** Record a finished service, called at `calledAt` and finished at `finishedAt`. */
export function recordService(
  state: EstimatorState,
  calledAt: number,
  finishedAt: number,
  options: EstimatorOptions = DEFAULT_ESTIMATOR,
): EstimatorState {
  if (options.alpha === 0) return state;
  // ">=": calling the last person in line empties it at the very moment of the call.
  if (options.dropIdleSamples && (state.empty || state.lastEmptyAt >= calledAt)) return state;
  const seconds = Math.min(
    Math.max((finishedAt - calledAt) / 1000, MIN_SAMPLE_SECONDS),
    state.serviceSeconds * MAX_SAMPLE_FACTOR,
  );
  // The host's guess counts as one sample, so the first real one moves the estimate halfway.
  const weight = Math.max(options.alpha, 1 / (state.samples + 2));
  return {
    ...state,
    serviceSeconds: state.serviceSeconds + weight * (seconds - state.serviceSeconds),
    samples: state.samples + 1,
  };
}

/** Note whether anyone is waiting after a change. */
export function trackLine(state: EstimatorState, waiting: number, now: number): EstimatorState {
  if (waiting === 0 && !state.empty) return { ...state, empty: true, lastEmptyAt: now };
  if (waiting > 0 && state.empty) return { ...state, empty: false };
  return state;
}

/**
 * The line's pace. A counter is working if it's serving someone or was active within the last
 * two services. Free working counters will call someone almost at once; busy ones are expected
 * to finish when their current service reaches the average. Before anyone has been called,
 * every configured counter is assumed to open.
 */
export function pace(
  state: EstimatorState,
  counters: Counter[],
  calledAt: (ticketId: string) => number | null,
  now: number,
): Pace {
  const service = state.serviceSeconds;
  const window = Math.max(2 * service * 1000, 10 * 60 * 1000);
  const working = counters.filter(
    (c) => c.serving !== null || (c.lastActiveAt > 0 && now - c.lastActiveAt < window),
  );
  if (working.length === 0) {
    const perTicket = service / Math.max(1, counters.length);
    return { secondsPerTicket: perTicket, free: counters.length, nextFreeIn: perTicket };
  }
  const remaining = working
    .filter((c) => c.serving !== null)
    .map((c) => {
      const at = calledAt(c.serving ?? "");
      const elapsed = at === null ? 0 : (now - at) / 1000;
      // Past the average, it still isn't over: assume a little longer rather than none.
      return Math.max(service - elapsed, service * 0.1);
    });
  const perTicket = service / working.length;
  return {
    secondsPerTicket: perTicket,
    free: working.length - remaining.length,
    nextFreeIn: remaining.length > 0 ? Math.min(...remaining) : perTicket,
  };
}
