import { committedItemAuthors } from './review-independence.js';
import { agentSessionDigest } from './person.js';
import { effectiveItemHead } from './source-advance-state.js';
import { itemReviewPolicy } from './review-independence.js';
import { twoTierReviews } from './review-independence.js';
/**
 * pullboard next --verify (V15, #807): before a review is offered, every submitted head that no longer merges onto
 * the trunk goes back to its builder with Git's conflicting files, so no reviewer reserves work that cannot land.
 */
import { Refused } from './refused.js';
import { refuseSelfSession } from './item-sessions.js';
import { itemAuthors } from './item-authors.js';
import { shownPath } from '../packages/kernel/src/core/registry-guards.js';

/**
 * Return each submitted head that conflicts with the trunk to its builder, recorded as a conflict reopen (#807).
 * Git decides, in memory, exactly as landing does; a board with no recorded trunk keeps today's offers.
 * A refused return throws unless the head already left review, so a known conflict is never offered.
 *
 * @param {string} root
 * @param {any} board
 * @param {{ ordered: (operation: string, args: any[]) => Promise<any>, trunkMerge: (root: string, commit: string) => { commit: string, files: string[] | null } }} deps
 * @returns {Promise<{ id: number, files: string[] }[]>}
 */
export async function returnUnmergeable(root, board, me, { ordered, trunkMerge, listItems, itemById }) {
  const returned = [];
  for (const item of listItems(board).filter((entry) => entry.item_status === 'submitted' && entry.item_commit)) {
    let merge;
    try { merge = trunkMerge(root, effectiveItemHead(board, item) ?? item.item_commit); }
    catch (error) { if (error instanceof Refused) return returned; throw error; }
    if (!merge.files?.length) continue;
    try {
      await ordered('reopen', [item.item_id, { agentId: me.id, automaticConflict: true }]);
      returned.push({ id: item.item_id, files: merge.files });
    } catch (error) {
      // Only a race is forgiven: another move already took the head out of review. A head still waiting
      // when its return was refused would otherwise be the next one offered.
      const now = itemById(board, item.item_id);
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
 * @param {string | undefined} digest
 * @param {{listItems: Function}} services
 * @returns {number[]}
 */
export function ownSessionReviews(info, board, digest = agentSessionDigest(), { listItems }) {
  return listItems(board).filter((item) => item.item_status === 'submitted').flatMap((item) => {
    try { refuseSelfSession(info, item, digest, itemAuthors(board, item, { committedItemAuthors, twoTierReviews }), { commitOnly: twoTierReviews(board) && itemReviewPolicy(board, item.item_id).tier === 'standard' }); return []; }
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
 * @param {{ ordered: (operation: string, args: any[]) => Promise<any>, idArg: (value: any, what: string) => number, trunkMerge: Function, listItems: Function, itemById: Function, getItem: Function, mainRedReviewItems: Function }} deps
 */
export async function nextReview(ctx, board, me, values, { ordered, idArg, trunkMerge, listItems, itemById, getItem, mainRedReviewItems }) {
  for (const { id, files } of await returnUnmergeable(ctx.info.root, board, me, { ordered, trunkMerge, listItems, itemById })) {
    // Stderr in every mode, so a --json caller still sees why the queue shrank.
    const line = `returned #${id} to its builder unreviewed: it no longer merges onto the trunk (${files.map(shownPath).join(', ')})`;
    if (ctx.io.stderr) ctx.io.stderr.write(line + '\n'); else ctx.io.err?.(line);
  }
  const reservation = { agentId: me.id, leaseMs: ctx.config.reviewLeaseMs, policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family };
  if (values.verifyId !== undefined) {
    const id = idArg(values.verifyId, 'an item id after --verify');
    const item = getItem(board, id);
    refuseSelfSession(ctx.info, item, agentSessionDigest(), itemAuthors(board, item, { committedItemAuthors, twoTierReviews }), { commitOnly: twoTierReviews(board) && itemReviewPolicy(board, item.item_id).tier === 'standard' });
    return { item: await ordered('reserveReview', [id, reservation]), reasons: [] };
  }
  return await ordered('reserveNextReview', [{ agentId: me.id, lane: me.lane, leaseMs: ctx.config.reviewLeaseMs, policy: ctx.config.verify.policy,
    familyPolicy: ctx.config.verify.family, runnable: values.runnable, routes: values.routes, observeIdle: values.observeIdle, skipIds: ownSessionReviews(ctx.info, board, undefined, { listItems }), priority: mainRedReviewItems(ctx.info.root, board) }]);
}
