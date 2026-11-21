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
  try { return await (await import('./cli-main/run.js')).main(argv, streams); }
  // A board call by the claiming seat snapshots its claimed item folder, once a minute per item; never a failure of the command [C7,#12568].
  finally { if (streams?.wip || globalThis[Symbol.for('pullboard.boardCall')]) await (await import('./beater.js')).snapshotOnBoardCall(streams?.cwd ?? process.cwd(), streams?.wip); }
}
