import { reviewPatchAuthors } from '../io/review/composition.js';
import { compositionSessionOptions } from '../io/review/composition.js';
import { reviewCompanionOffer } from '../../../items/index.js';
import { retryReviewCommit } from './verdict/retry.js';
import { git } from '../../../git/index.js';
import { isClean } from '../../../git/index.js';
import { untracked } from '../../../git/index.js';
import { committedItemAuthors } from '../io/review/independence.js';
import { earlierHolderProblem } from '../io/review/independence.js';
import { effectiveItemHead } from './advance.js';
import { itemReviewPolicy } from '../io/review/independence.js';
import { twoTierReviews } from '../io/review/independence.js';
/**
 * pullboard next --verify (V15, #807): before a review is offered, every submitted head that no longer merges onto
 * the trunk goes back to its builder with Git's conflicting files, so no reviewer reserves work that cannot land.
 */
import { Refused } from '../../../kernel/index.js';
import { refuseSelfSession } from '../../../items/index.js';
import { itemAuthors } from '../../../items/index.js';
import { shownPath } from '../../../kernel/index.js';

/**
 * The other seat holding a live review reservation on this head, or null (#1356). The reviewer's own
 * reservation never blocks its own return; the reopen authority rechecks this inside its write.
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
 * The conflict is applied by whichever seat next asks for review after the reservation ends.
 */
async function noticeHolder(board, ordered, me, holder, item, merge) {
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
 * @param {{ ordered: (operation: string, args: any[]) => Promise<any>, trunkMerge: (root: string, commit: string) => { commit: string, files: string[] | null } }} deps
 * @returns {Promise<{ id: number, files: string[] }[]>}
 */
export async function returnUnmergeable(root, board, me, { ordered, trunkMerge, listItems, itemById, phase }) {
  const returned = [];
  for (const item of listItems(board).filter((entry) => entry.item_status === 'submitted' && entry.item_commit)) {
    phase?.('review merge check', item.item_id);
    let merge;
    try { merge = trunkMerge(root, effectiveItemHead(board, item) ?? item.item_commit); }
    catch (error) { if (error instanceof Refused) return returned; throw error; }
    if (!merge.files?.length) continue;
    const holder = heldByOther(board, item, me.id);
    if (holder) { await noticeHolder(board, ordered, me, holder, item, merge); continue; }
    try {
      await ordered('reopen', [item.item_id, { agentId: me.id, automaticConflict: true }]);
      returned.push({ id: item.item_id, files: merge.files });
    } catch (error) {
      // A peer reserved the head after this snapshot: the authority refused inside its write, so tell that reviewer.
      if (error instanceof Refused && error.code === 'REVIEW_HELD') {
        const now = itemById(board, item.item_id);
        await noticeHolder(board, ordered, me, now.item_review_by, now, merge);
        continue;
      }
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
export function ownSessionReviews(info, board, digest, { listItems, reviewer }) {
  return listItems(board).filter((item) => item.item_status === 'submitted').flatMap((item) => {
    if (reviewer && earlierHolderProblem(board, item, reviewer)) return [item.item_id];
    try { refuseSelfSession(info, item, digest, itemAuthors(board, item, { reviewPatchAuthors, committedItemAuthors, twoTierReviews }), { commitOnly: twoTierReviews(board) && itemReviewPolicy(board, item.item_id).tier === 'standard', ...compositionSessionOptions(board, item), independence: board.reviewIndependence }); return []; }
    catch (error) { if (error instanceof Refused && error.code === 'SELF_SESSION_VERIFY') return [item.item_id]; throw error; }
  });
}

/** Place active companions in the leased checkout before any reservation route hands it over. */
function composedReservation(ctx, board, found, getItem) {
  if (!found.item) return found;
  const root = ctx.info.root;
  const { itemPolicy, requireTrunkMerge } = board.enginePorts.sandboxPolicyReads;
  const companions = reviewCompanionOffer(root, board, found.item,
    { effectiveItemHead, itemPolicy, requireTrunkMerge, retryReviewCommit, getItem });
  if (!companions) return found;
  if (!isClean(root)) throw new Refused('DIRTY', 'commit or preserve checkout changes before reserving a companion review');
  if (untracked(root).length) throw new Refused('UNTRACKED', 'commit or preserve untracked files before reserving a companion review');
  // Git also protects ignored files that an ordinary checkout would silently overwrite.
  git(root, ['switch', '--detach', '--no-overwrite-ignore', companions.commit]);
  return { ...found, companions };
}

/**
 * The forced-landed items with no verdict, newest landing first: withdrawn with a merged commit, a forced `merged` event, and no verdict recorded.
 * Why: the blitz lander merged about 1,600 items around review; a post-landing verdict is the only review they get (#4991).
 *
 * @param {any[]} items - every item on the board
 * @param {(item: any) => { event_id: number, event_kind: string, event_detail?: string }[]} eventsOf - one item's events
 * @returns {any[]} newest landing first
 */
export function forcedLandedUnreviewed(items, eventsOf) {
  const rows = [];
  for (const item of items) {
    if (item.item_status !== 'withdrawn' || !item.item_merged_commit || item.item_verdict) continue;
    const merge = eventsOf(item).findLast(event => event.event_kind === 'merged' && JSON.parse(event.event_detail || '{}').forced === true);
    if (merge) rows.push({ item, at: merge.event_id });
  }
  return rows.sort((a, b) => b.at - a.at).map(row => row.item);
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
export async function nextReview(ctx, board, me, values, { ordered, idArg, trunkMerge, listItems, itemById, getItem, mainRedReviewItems, agentSessionDigest, nextFor, landedOffer }) {
  for (const { id, files } of await returnUnmergeable(ctx.info.root, board, me, { ordered, trunkMerge, listItems, itemById, phase: ctx.io.nextPhase })) {
    // Stderr in every mode, so a --json caller still sees why the queue shrank.
    const line = `returned #${id} to its builder unreviewed: it no longer merges onto the trunk (${files.map(shownPath).join(', ')})`;
    if (ctx.io.stderr) ctx.io.stderr.write(line + '\n'); else ctx.io.err?.(line);
  }
  // A review that plain next reserved on its own lapses in 5 minutes unless the seat starts it, so one idle builder never locks out the real reviewer.
  const leaseMs = values.unstartedReviewLapse ? Math.min(ctx.config.reviewLeaseMs, 5 * 60_000) : ctx.config.reviewLeaseMs;
  const reservation = { agentId: me.id, leaseMs, policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family };
  if (values.verifyId !== undefined) {
    const id = idArg(values.verifyId, 'an item id after --verify');
    const item = getItem(board, id);
    const earlier = earlierHolderProblem(board, item, me.id);
    if (earlier) throw earlier;
    refuseSelfSession(ctx.info, item, agentSessionDigest(), itemAuthors(board, item, { reviewPatchAuthors, committedItemAuthors, twoTierReviews }), { commitOnly: twoTierReviews(board) && itemReviewPolicy(board, item.item_id).tier === 'standard', ...compositionSessionOptions(board, item), independence: board.reviewIndependence });
    ctx.io.nextPhase?.('review reservation', id);
    return composedReservation(ctx, board, { item: await ordered('reserveReview', [id, reservation]), reasons: [] }, getItem);
  }
  const selection = { agentId: me.id, lane: me.lane, leaseMs, policy: ctx.config.verify.policy,
    familyPolicy: ctx.config.verify.family, runnable: values.runnable, routes: values.routes,
    omitIds: values.omitIds,
    observeIdle: values.observeIdle, skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems, reviewer: me.id }),
    priority: mainRedReviewItems(ctx.info.root, board) };
  // An empty read has no move to authorize. The write authority repeats selection atomically
  // when a candidate exists, so a stale read can never reserve another reviewer's work.
  if (nextFor) {
    const preview = nextFor(board, { ...selection, verify: true, sessionIds: selection.skipIds });
    // With verify.landedReviews on, an empty ordinary queue offers the newest forced landing that has no verdict; it takes no reservation, since a landed item takes one verdict [C7].
    if (!preview.item && ctx.config.verify?.landedReviews === true && values.verifyId === undefined) {
      const landed = landedOffer?.(board, me, { omitIds: values.omitIds, skipIds: selection.skipIds });
      if (landed) return { item: landed, reasons: [], landed: true };
    }
    if (!preview.item) return preview;
  }
  const { omitIds = [], ...reservationSelection } = selection;
  const found = await ordered('reserveNextReview', [{ ...reservationSelection,
    skipIds: [...new Set([...reservationSelection.skipIds, ...omitIds])] }]);
  return composedReservation(ctx, board, found, getItem);
}
