/**
 * A pulled landing's verdict freshness: before a land job is offered, each accepted item's verdict is projected against
 * the main it lands onto, and a verdict a plain main change made stale is
 * withdrawn and the item reopened to its lane [B3,C7].
 */
import * as store from '../../../../store/index.js';
import { staleVerdictRefusal } from '../../../../verify/index.js';
import { verdictProjector } from '../../../../verify/index.js';

/**
 * The board's items with every stale accepted verdict taken out of this offer: a plain stale one is reopened to its
 * lane (and comes back with status open); any other stale one keeps its accept, is named with its refusal, and comes
 * back held from this offer. Why: a pulled land job took every verified item, so an accept made against an older main
 * landed a change its reviewer never saw composed with that main [B3,C7].
 *
 * @param {object} board - The open board.
 * @param {string} root - The main checkout.
 * @param {string} main - The main commit the offer lands onto.
 * @param {object[]} all - The board's items, as listItems returns them.
 * @param {{ candidate: (item: object) => boolean, write: (operation: string, args: unknown[]) => Promise<unknown>, say: (line: string) => void, hunkKeyed?: boolean }} ports -
 *   candidate: the items this offer would take; write: the command's ordered board write.
 * @returns {Promise<object[]>} `all`, with each stale candidate no longer landable.
 */
export async function withoutStaleVerdicts(board, root, main, all, { candidate, write, say, hunkKeyed = false }) {
  const projector = verdictProjector(root, board, { main }, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, hunkKeyed });
  const blocked = [];
  for (const item of all) {
    if (item.item_status !== 'verified' || item.item_merged_commit || !candidate(item)) continue;
    const stale = projector.state({ ...item, item_landing_commit: store.checkedLandingCommit(board, item) });
    if (stale?.code === 'STALE_VERDICT') blocked.push({ id: item.item_id, ...stale });
  }
  if (!blocked.length) return all;
  const selected = { blocked };
  await returnStaleVerdicts(board, selected, write, say);
  const reopened = new Set(selected.blocked.filter(entry => entry.code === 'STALE_REOPENED').map(entry => entry.id));
  const kept = new Set(selected.blocked.filter(entry => entry.code !== 'STALE_REOPENED').map(entry => entry.id));
  for (const entry of selected.blocked) if (entry.code === 'STALE_VERDICT') say(staleVerdictRefusal({ item_id: entry.id }, entry).message);
  return all.map(item => reopened.has(item.item_id) ? { ...item, item_status: 'open' }
    : kept.has(item.item_id) ? { ...item, item_hold_at: item.item_hold_at ?? 'stale verdict' } : item);
}

/**
 * Reopen each candidate whose verdict a concrete main change made stale: the accept is withdrawn, the item reopens
 * with no owner and the changed file named, and its blocked entry becomes STALE_REOPENED. A moved landing, a legacy
 * unsealed review or unreadable history keeps the refusal, since those are not a plain main change [B3,C7].
 */
async function returnStaleVerdicts(board, selected, write, say) {
  const kept = [];
  for (const entry of selected.blocked) {
    const plain = entry.code === 'STALE_VERDICT' && entry.file && entry.commit && !entry.landingCode && !entry.legacy;
    const item = plain ? store.getItem(board, entry.id) : null;
    if (!item || item.item_status !== 'verified' || item.item_merged_commit) { kept.push(entry); continue; }
    const where = `${entry.file} changed on main in ${entry.commit.slice(0, 12)}`;
    const note = `verdict stale: ${where}, so the reviewed change no longer composes unchanged; merge current main, commit and resubmit`;
    try {
      await write('reopen', [entry.id, { agentId: 'coordinator', withdrawVerdict: true, note }]);
      say(`STALE_VERDICT #${entry.id} reopened to its lane: ${where}`);
      kept.push({ ...entry, code: 'STALE_REOPENED', message: note });
    } catch (error) {
      say(`STALE_VERDICT #${entry.id} could not be reopened: ${error?.code ?? 'ERROR'} ${String(error?.message ?? '').slice(0, 160)}`);
      kept.push(entry);
    }
  }
  selected.blocked = kept;
}
