/** The CLI front door: tool selection, checkout leases, startup tracing and the dispatcher [C7]. */
export { selectedToolEntry } from './pinned/tool/build.js';
export { CHECKOUT_LEASES } from './cli-main/session.js';
export { CHECKOUT_BOARD_ONLY } from './cli-main/session.js';
export { traceServeStartup } from './cli-main/session.js';
export { asksVersion } from './cli-main/options.js';

/**
 * Dispatch one CLI run to the split command runner, loaded only when a run starts.
 * Why: the front door dispatches rather than only forwarding, so it stays the CLI entry and never counts as a cells
 * shim; and loading the runner on first use keeps a bare import of this module (tool selection, --version) cheap.
 */
export async function main(argv, streams) {
  return (await import('./cli-main/run.js')).main(argv, streams);
}
