/** Checkout leases and the opt-in startup trace shared by the CLI dispatcher modules [A2,C7]. */
import { loadavg } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { environmentAdapter } from '../../../../../packages/env/index.js';

import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const environment = environmentAdapter();
const fs = fileSystemAdapter();

export const CHECKOUT_LEASES = new WeakMap();
export const CHECKOUT_BOARD_ONLY = new WeakMap();

/** Append an opt-in startup phase marker for the real CLI fixture measurement [A2,C7]. */
export function traceServeStartup(phase) {
  const path = environment.get('PULLBOARD_STARTUP_TRACE_FILE');
  const entry = environment.get('PULLBOARD_STARTUP_TRACE_ENTRY');
  if (!path || !entry || resolve(process.argv[1] ?? '') !== resolve(entry)) return;
  try {
    fs.appendFile(path, `${JSON.stringify({ phase, at: Date.now(), elapsedMs: performance.now(),
      processId: process.pid, cpuUsage: process.cpuUsage(), loadAverage: loadavg(),
      eventLoopUtilization: performance.eventLoopUtilization() })}\n`);
  } catch {
    // Diagnostic tracing must not change normal CLI behavior.
  }
}
