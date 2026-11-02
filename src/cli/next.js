import { mainPolicy } from '../../packages/sandbox/index.js';
import { claimWorktrees } from '../../packages/activity/index.js';
import { claimOverlapLines } from '../../packages/activity/index.js';
import { claimOverlaps } from '../../packages/items/index.js';
import { rejectionReturnEnabled } from '../../packages/store/index.js';
import { agentSessionDigest } from '../../packages/person/index.js';
import { recoverOwnSubmitHandoffs } from '../submit-handoff.js';
import { pendingSubmitHandoff } from '../submit-handoff-read.js';
/** Helpers for `pullboard next`: one pick-and-claim loop and its wait labels. Split from src/cli.js, which re-exports it [C7]. */
import { nextSessionSeats } from '../../packages/seats/index.js';
import { sessionSeatReaders } from './seat-ports.js';
import { mainRedReviewItems } from '../../packages/landing/index.js';
import { computedReturnArgs } from '../../packages/landing/index.js';
import { focusReviewFirst } from '../../packages/roadmap/index.js';
import { focusReasons } from '../../packages/roadmap/index.js';
import { milestoneFocus } from '../../packages/roadmap/index.js';
import { mainLaneWork } from '../next-steps.js';
import * as store from '../board.js';
import { withBoardRead } from '../cli-context.js';
import { agentDisplayName } from '../cli-context.js';
import { idArg } from '../cli-context.js';
import { withBoard } from '../cli-context.js';
import { COORDINATOR } from '../../packages/config/index.js';
import { headCommit } from '../git.js';
import { laneNames } from '../../packages/seats/index.js';
import { Refused } from '../../packages/kernel/index.js';
import { mainRedReworkItems } from '../../packages/landing/index.js';
import { nextReview } from '../../packages/verify/index.js';
import { ownSessionReviews } from '../../packages/verify/index.js';
import { trunkMerge } from '../../packages/sandbox/index.js';
import { relayLinked } from '../../packages/link/index.js';
import { checkMainVerifier } from './verify.js';
import { ordered } from './claim.js';
import { claimOrdered } from './claim.js';
import { currentReworkRoutingPolicy } from './claim.js';
import { whoAmI } from './join.js';
import { MainSpecMerged } from './claim.js';
import { claimFreezer } from './claim.js';
import { dirtyFiles } from './submit.js';

/** Label the holder at the start of a generated wait reason without rewriting its quoted reason. */
export function displayedWait(reason, agents, config) {
  return reason.replace(/^(\S+)( holds the )/, (_, id, rest) => `${agentDisplayName(agents, config, id)}${rest}`)
    .replace(/^(#\d+ is held by )(\S+)(: )/, (_, before, id, after) => `${before}${agentDisplayName(agents, config, id)}${after}`);
}

/**
 * The files an agent has been working in (N20): what its latest three items touched, and what is
 * uncommitted in its worktree now.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @returns {string[]}
 */
function warmFiles(ctx, board, me) {
  const recent = store
    .listItems(board, { all: true })
    .filter((item) => item.item_built_by === me.id)
    .sort((first, second) => second.item_updated_at.localeCompare(first.item_updated_at))
    .slice(0, 3)
    .flatMap((item) => store.itemFiles(item));
  return [...new Set([...recent, ...dirtyFiles(ctx.info.root)])];
}

/**
 * One loop of `next`: claim the next free item, or reserve the next review (V15). A claim that loses
 * a race to another agent is not an error; the caller looks again. A review is looked for and
 * reserved in one transaction, so it cannot lose that race.
 *
 * @param {any} ctx
 * @param {any} values
 * @returns {{ item?: any, held?: boolean, retry?: boolean, reasons?: string[] }}
 */
export async function nextOnce(ctx, values) {
  if (!values.verify) await recoverOwnSubmitHandoffs(ctx, withBoardRead(ctx, board => whoAmI(ctx, board)).id);
  // Select on a read-only board; only a claim, or a review reservation, opens it for writing (#1047).
  if (values.verify) return withBoardRead(ctx, board => {
    checkMainVerifier(ctx, board, values);
    return nextReview(ctx, board, whoAmI(ctx, board), values, {
      ordered: (operation, args) => withBoard(ctx, writable => ordered(ctx, writable, operation,
        operation === 'reopen' ? computedReturnArgs(writable, args) : args)),
      nextFor: store.nextFor, idArg, trunkMerge, listItems: store.listItems,
      itemById: store.itemById, getItem: store.getItem, mainRedReviewItems, agentSessionDigest,
    });
  });
  const looked = withBoardRead(ctx, (board) => nextPick(ctx, board, values));
  if (looked.autoReview) {
    try { return { ...await nextOnce(ctx, { ...values, build: false, verify: true, verifyId: looked.autoReview.item_id }), review: true }; }
    catch (error) {
      if (error instanceof Refused && ['REVIEW_HELD', 'NOT_SUBMITTED'].includes(error.code)) return { retry: true,
        retryDetail: { phase: 'first-review reservation', item: looked.autoReview.item_id, code: error.code } };
      throw error;
    }
  }
  if (!looked.claim) return looked;
  return await withBoard(ctx, async (board) => {
    const picked = nextPick(ctx, board, values);
    if (picked.autoReview) return { retry: true, retryDetail: { phase: 'first-review reservation', item: picked.autoReview.item_id, code: 'REVIEW_BECAME_MANDATORY' } };
    if (!picked.claim) return picked;
    // Claims belong to the seat that ran next, in its own item folder; next never routes a claim to another seat or opens one.
    const { me: holder, item, held, shared, reasons, reviewSkipped } = picked;
    const target = ctx;
    ctx.io.nextPhase?.('claim', item.item_id);
    try {
      await claimOrdered(target, board, [item.item_id, { agentId: holder.id, lane: holder.lane, leaseMs: target.config.leaseMs, freeze: claimFreezer(target, board), head: headCommit(target.info.root), reviewSkipped, autoNext: true }]);
    } catch (error) {
      if (error instanceof MainSpecMerged) return { retry: true, specMerged: { item: item.item_id, rows: error.rows } };
      if (error instanceof Refused && ['HELD', 'ITEM_HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) return { retry: true, retryDetail: { phase: 'claim', item: item.item_id, code: error.code, message: error.message } };
      throw error;
    }
    return { item: store.getItem(board, item.item_id), shared, held, reviewSkipped, reasons };
  });
}

/** Name the best item in another lane without claiming it; that lane's own seat builds it [N2,B13]. */
function otherLaneWork(me, item, reasons) {
  const line = `#${item.item_id} (${item.item_title}) is next, in the ${item.item_lane} lane; this seat builds the ${me.lane} lane, so it stays unclaimed for a ${item.item_lane} seat: pullboard worktree ${item.item_lane} --model "<model name>"`;
  return { reasons: [...(reasons ?? []), line], idleReason: 'nothing-eligible', otherLane: { item: item.item_id, lane: item.item_lane } };
}

/** The selection half of one next loop: the item to claim, or what to print instead. It only reads (#1047). */
function nextPick(ctx, board, values) {
  const me = whoAmI(ctx, board);
  const items = store.listItems(board), agents = store.listAgents(board);
  const workingFiles = claimWorktrees(items, agents);
  for (const line of claimOverlapLines(items, agents, me.id, claimOverlaps, workingFiles)) ctx.io.err(line);
  const warm = warmFiles(ctx, board, me);
  const seats = nextSessionSeats(ctx, board, sessionSeatReaders);
  // A claim belongs to the seat that made it: seats of one session share its environment, so a sibling's claim is
  // never this seat's to resume or be pointed at (#958).
  const heldItem = seats ? store.listItems(board).find((item) => item.item_status === 'claimed'
    && item.item_parent_id === null && item.item_owner === me.id && !pendingSubmitHandoff(board, item)
    && store.ROUTES.indexOf(item.item_route) <= store.ROUTES.indexOf(me.route)) : undefined;
  const selection = { buildBudgetMinutes: mainPolicy(ctx.info.root).config.itemBuildBudgetMinutes ?? 30, agentId: me.id, lane: me.lane, runnable: values.runnable, routes: values.routes, warm,
    policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family,
    skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }),
    priority: mainRedReworkItems(ctx.info.root, board), omitIds: values.omitIds ?? [], observeIdle: values.observeIdle,
    reworkRoutingPolicy: currentReworkRoutingPolicy(ctx, board), workingFiles };
  const firstReview = () => store.reviewOffer(board, { ...selection, mandatoryOnly: true,
    priority: [], skipIds: selection.skipIds });
  const mandatory = relayLinked(ctx.info.root) ? store.withVerifierStanding(board, { root: true }, firstReview) : firstReview();
  if (mandatory?.mandatory && !items.some(item => item.item_status === 'claimed' && item.item_owner === me.id && !pendingSubmitHandoff(board, item))) {
    return { autoReview: mandatory.item, item: mandatory.item, reasons: [] };
  }
  const own = heldItem && !rejectionReturnEnabled(board) ? { item: heldItem, reasons: [], shared: [] } : store.nextFor(board, selection);
  const picked = own.item || !seats ? own : store.nextFor(board, { ...selection,
    lanes: laneNames(ctx.config).filter(lane => lane !== COORDINATOR && lane !== me.lane) });
  const { item, reasons, shared } = picked;
  const held = item?.item_status === 'claimed';
  /** Offer only reviews this seat may give; a linked board previews its engine-27 verifier standing (#579). */
  const findOffer = () => store.reviewOffer(board, { agentId: me.id, lane: me.lane, policy: ctx.config.verify.policy,
    familyPolicy: ctx.config.verify.family, starveMinutes: ctx.config.review?.starveMinutes ?? 10, ratio: ctx.config.verify.reviewRatio, runnable: values.runnable, routes: values.routes,
    observeIdle: values.observeIdle, omitIds: values.omitIds ?? [], skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }), priority: mainRedReviewItems(ctx.info.root, board) });
  const offer = held ? null : relayLinked(ctx.info.root) ? store.withVerifierStanding(board, { root: true }, findOffer) : findOffer();
  const focus = milestoneFocus(board, { milestones: store.milestones });
  const findFocusedReview = () => store.nextFor(board, { agentId: me.id, lane: me.lane, verify: true,
    policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family, runnable: values.runnable, routes: values.routes,
    omitIds: values.omitIds ?? [], skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }), focusOnly: true });
  const focusedReview = focus && !held && !values.build
    ? relayLinked(ctx.info.root) ? store.withVerifierStanding(board, { root: true }, findFocusedReview) : findFocusedReview() : null;
  const focusOffer = focusedReview?.item && focus.ids.has(focusedReview.item.item_id)
    ? { item: focusedReview.item, queue: store.reviewQueue(board), ratio: ctx.config.verify.reviewRatio } : null;
  const selectedOffer = focusOffer ?? offer;
  if (selectedOffer?.item && !values.build && !(rejectionReturnEnabled(board) && item?.item_verdict === 'REJECT' && item.item_built_by === me.id) && (focusOffer || (!focus || focus.ids.has(selectedOffer.item.item_id) || !item || !focus.ids.has(item.item_id)) && (selectedOffer.urgent || focusReviewFirst(board, selectedOffer.item, item, { milestones: store.milestones })))) return { item: selectedOffer.item, offer: selectedOffer, build: item ?? null, reasons: focusReasons(board, selectedOffer.item, [], { milestones: store.milestones }) };
  if (!item) return { reasons, ...(values.observeIdle ? { idleReason: [picked.idleReason, !values.build && offer?.idleReason].find(reason => ['held', 'review-family', 'main-red'].includes(reason)) ?? picked.idleReason ?? 'unknown' } : {}), laneWork: ctx.info.isMain ? mainLaneWork(store.listItems(board)) : null };
  const reviewSkipped = values.build && !held
    ? { offeredItem: offer?.item?.item_id ?? null, ratio: offer?.ratio ?? ctx.config.verify.reviewRatio, ...store.reviewQueue(board) } : null;
  if (!held && item.item_lane !== me.lane) return otherLaneWork(me, item, reasons);
  return { claim: true, me, item, held, shared, reasons, reviewSkipped };
}

