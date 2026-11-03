/** The CLI front door: tool selection, checkout leases, startup tracing and the dispatcher [C7]. */
import { main as runMain } from './cli-main/run-main.js';
export { selectedToolEntry } from './pinned-tool-build.js';
export { CHECKOUT_LEASES } from './cli-main/session.js';
export { CHECKOUT_BOARD_ONLY } from './cli-main/session.js';
export { traceServeStartup } from './cli-main/session.js';
export { asksVersion } from './cli-main/options.js';

/**
 * Dispatch one CLI run to the split command runner.
 * Why: the front door dispatches rather than only forwarding, so it stays the CLI entry and never counts as a cells shim.
 */
export function main(argv, streams) {
  return runMain(argv, streams);
}
