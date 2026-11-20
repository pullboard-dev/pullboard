/** The note a claim of an after-gate dependent leaves on it: the parent, the parent head and the claim time [C7,#12325]. */
import { appendFact } from '../fact.js';

/**
 * Record one note fact on a dependent whose claim took a gate-green after-gate parent, so the thread shows what the build started from.
 * Why a note through appendFact with no engine gate: replay of an older board is unchanged, and a dependent with no after-gate parent records nothing.
 *
 * @param {any} board The open board, inside the claim.
 * @param {number} id The dependent that was claimed.
 * @param {{ parent: number, head: string, agentId: string }} record The after-gate base the claim recorded and the claiming seat.
 * @returns {object} The fact written.
 */
export function recordAfterGateClaim(board, id, { parent, head, agentId }) {
  const at = board.clock.now().toISOString();
  return appendFact(board, id, { agentId, kind: 'note', text: `after-gate claim: parent #${parent} at head ${head}, claimed ${at}` });
}
