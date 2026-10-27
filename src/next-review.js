/**
 * pullboard next --verify (V15, #807): before a review is offered, every submitted head that no longer merges onto
 * the trunk goes back to its builder with Git's conflicting files, so no reviewer reserves work that cannot land.
 */
import * as store from './board.js';
import { Refused } from './refused.js';
import { refuseSelfSession } from './item-sessions.js';
import { itemAuthors } from './item-authors.js';
import { shownPath } from './trunk-conflict.js';

/**
 * The other seat holding a live review reservation on this head, or null (#1356). A reservation
 * belongs to its reviewer until it ends, so a conflict must not return the head out from under them.
 * The reviewer's own reservation never blocks its own return.
 *
 * @param {any} board
 * @param {any} item
 * @param {string} agentId - the seat asking for the return
 * @returns {string | null}
 */
function heldByOther(board, item, agentId) {
  const holder = item.item_review_by;
  if (!holder || holder === agentId) return null;
  return Date.parse(item.item_review_until ?? '') > board.clock.now().getTime() ? holder : null;
}

/**
 * Tell the reviewer holding a head that the trunk now conflicts with it, once per trunk commit (#1356).
 * The conflict itself is applied later, by whichever seat next asks for review after the reservation ends.
 *
 * @param {any} board
 * @param {{ ordered: (operation: string, args: any[]) => Promise<any> }} deps
 * @param {{ id: string }} me - the seat that found the conflict and sends the notice
 * @param {string} holder - the reviewer whose reservation holds the head
 * @param {any} item
 * @param {{ commit: string, files: string[] }} merge
 * @returns {Promise<void>}
 */
async function noticeHolder(board, { ordered }, me, holder, item, merge) {
  const text = `#${item.item_id} conflicts with the trunk at ${merge.commit.slice(0, 12)} in ${merge.files.map(shownPath).join(', ')}; your review holds it until ${item.item_review_until}, and it goes back to its builder when that review ends`;
  if (board.db.prepare('SELECT 1 FROM shout WHERE shout_to = ? AND shout_text = ?').get(holder, text)) return;
  await ordered('shout', [{ from: me.id, to: holder, text, lanes: [] }]);
}

/**
 * Return each submitted head that conflicts with the trunk to its builder, recorded as a conflict reopen (#807).
 * Git decides, in memory, exactly as landing does; a board with no recorded trunk keeps today's offers.
 * A refused return throws unless the head already left review, so a known conflict is never offered.
 * A head another seat holds under a live reservation is not returned; its holder is told instead (#1356).
 *
 * @param {string} root
 * @param {any} board
 * @param {{ id: string }} me
 * @param {{ ordered: (operation: string, args: any[]) => Promise<any>, trunkMerge: (root: string, commit: string) => { commit: string, files: string[] | null } }} deps
 * @returns {Promise<{ id: number, files: string[] }[]>}
 */
export async function returnUnmergeable(root, board, me, deps) {
  const { ordered, trunkMerge } = deps;
  const returned = [];
  for (const item of store.listItems(board).filter((entry) => entry.item_status === 'submitted' && entry.item_commit)) {
    let merge;
    try { merge = trunkMerge(root, item.item_commit); }
    catch (error) { if (error instanceof Refused) return returned; throw error; }
    if (!merge.files?.length) continue;
    const holder = heldByOther(board, item, me.id);
    if (holder) { await noticeHolder(board, deps, me, holder, item, merge); continue; }
    try {
      await ordered('reopen', [item.item_id, { agentId: me.id, automaticConflict: true }]);
      returned.push({ id: item.item_id, files: merge.files });
    } catch (error) {
      // Only a race is forgiven: another move already took the head out of review. A head still waiting
      // when its return was refused would otherwise be the next one offered.
      const now = store.itemById(board, item.item_id);
      if (!(error instanceof Refused) || (now.item_status === 'submitted' && now.item_commit === item.item_commit)) throw error;
    }
  }
  return returned;
}

/**
 * The submitted items this agent session built or submitted, by the very rule verify refuses them under
 * (refuseSelfSession), so next --verify never reserves a review its own session could not give. The session
 * ledger lives in this repository's Git directory and never on the board, so the ids travel with the move.
 *
 * @param {{ commonDir: string }} info
 * @param {any} board
 * @returns {number[]}
 */
export function ownSessionReviews(info, board, digest) {
  return store.listItems(board).filter((item) => item.item_status === 'submitted').flatMap((item) => {
    try { refuseSelfSession(info, item, digest, itemAuthors(board, item)); return []; }
    catch (error) { if (error instanceof Refused && error.code === 'SELF_SESSION_VERIFY') return [item.item_id]; throw error; }
  });
}

/**
 * The review half of one next loop: return heads that no longer merge, then reserve the named review or the next one.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string, lane: string }} me
 * @param {any} values
 * @param {{ ordered: (operation: string, args: any[]) => Promise<any>, idArg: (value: any, what: string) => number, trunkMerge: Function }} deps
 */
export async function nextReview(ctx, board, me, values, { ordered, idArg, trunkMerge }) {
  for (const { id, files } of await returnUnmergeable(ctx.info.root, board, me, { ordered, trunkMerge })) {
    // Stderr in every mode, so a --json caller still sees why the queue shrank.
    const line = `returned #${id} to its builder unreviewed: it no longer merges onto the trunk (${files.map(shownPath).join(', ')})`;
    if (ctx.io.stderr) ctx.io.stderr.write(line + '\n'); else ctx.io.err?.(line);
  }
  const reservation = { agentId: me.id, leaseMs: ctx.config.reviewLeaseMs, policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family };
  if (values.verifyId !== undefined) {
    const id = idArg(values.verifyId, 'an item id after --verify');
    const item = store.getItem(board, id);
    refuseSelfSession(ctx.info, item, undefined, itemAuthors(board, item));
    return { item: await ordered('reserveReview', [id, reservation]), reasons: [] };
  }
  return await ordered('reserveNextReview', [{ agentId: me.id, lane: me.lane, leaseMs: ctx.config.reviewLeaseMs, policy: ctx.config.verify.policy,
    familyPolicy: ctx.config.verify.family, runnable: values.runnable, routes: values.routes, skipIds: ownSessionReviews(ctx.info, board) }]);
}
