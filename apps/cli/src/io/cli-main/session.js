/** Checkout leases and the opt-in startup trace shared by the CLI dispatcher modules [A2,C7]. */
import { appendFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export const CHECKOUT_LEASES = new WeakMap();
export const CHECKOUT_BOARD_ONLY = new WeakMap();

/** Append an opt-in startup phase marker for the real CLI fixture measurement [A2,C7]. */
export function traceServeStartup(phase) {
  const path = process.env.PULLBOARD_STARTUP_TRACE_FILE;
  const entry = process.env.PULLBOARD_STARTUP_TRACE_ENTRY;
  if (!path || !entry || resolve(process.argv[1] ?? '') !== resolve(entry)) return;
  try {
    appendFileSync(path, `${JSON.stringify({ phase, at: Date.now(), elapsedMs: performance.now(),
      processId: process.pid, cpuUsage: process.cpuUsage(), loadAverage: loadavg(),
      eventLoopUtilization: performance.eventLoopUtilization() })}\n`);
  } catch {
    // Diagnostic tracing must not change normal CLI behavior.
  }
}
