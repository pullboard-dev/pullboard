/** Order a bounded native hook's presence refresh, dispatch and work warning through caller ports [I6,C7]. */

/**
 * Run one native hook event's work through the CLI's ports.
 *
 * The seats cell owns the order of the steps; the CLI supplies each step, so this worker never loads
 * the CLI or the board. A failed private presence observation never suppresses ordinary native context.
 *
 * @param {string} event
 * @param {{ heartbeat: () => unknown, dispatch: (args: string[]) => Promise<number>, inspect: () => Promise<void> }} ports
 */
export async function work(event, { heartbeat, dispatch, inspect }) {
  try { await heartbeat(); }
  catch { /* A failed private observation must not suppress the ordinary native context. */ }
  // An ended session frees its build claim at once instead of waiting out the idle clock (#1225).
  if (event === 'SessionEnd') { await dispatch(['release', '--session-end']); return; }
  // This explicit native heartbeat may claim work; ordinary read commands never do.
  await dispatch(['heartbeat']);
  if (event === 'SessionStart') {
    process.exitCode = await dispatch(['resume']);
    return;
  }
  await inspect();
}
