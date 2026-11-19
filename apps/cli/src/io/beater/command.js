/** A long CLI command keeps its seat alive with the same 60 s keepalive submit has [B3,C7,#5726]. */
import { environmentAdapter } from '../../../../../packages/env/index.js';

/** A long command's keepalive cadence: the same 60 s submit has always kept. */
export const COMMAND_KEEPALIVE_MS = 60_000;

/**
 * Beat the seat acting from `cwd` every 60 s while this command runs; returns the stop. This module imports only the env adapter,
 * and the gate cell loads on the first beat, so a command that ends within a minute pays nothing. Why: a 21-33 minute
 * `pullboard test` wait read as a gone seat, and its claim was taken mid-run (#5726). The timer is unref'd, so it never
 * keeps a command alive.
 */
export function keepCommandAlive(cwd, { everyMs = Number(environmentAdapter().get('PULLBOARD_KEEPALIVE_MS')) || COMMAND_KEEPALIVE_MS, every = setInterval, cancel = clearInterval } = {}) {
  const timer = every(() => import('../../../../../packages/gate/index.js').then(gate => gate.beatSeat(cwd)).catch(() => { /* retried on the next tick */ }), everyMs);
  timer?.unref?.();
  return () => cancel(timer);
}
