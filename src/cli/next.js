/** Helpers for `pullboard next`: one pick-and-claim loop and its wait labels. Split from src/cli.js, which re-exports it [C7]. */
import { laneSeatContext } from '../seat-checkout.js';
import { nextSessionSeats } from '../seat-checkout.js';
import { mainRedReviewItems } from '../main-red.js';
import { computedReturnArgs } from '../computed-conflict-return.js';
import { focusReviewFirst } from '../focus-milestone.js';
import { focusReasons } from '../focus-milestone.js';
import { mainLaneWork } from '../next-steps.js';
import * as store from '../board.js';
import { withBoardRead } from '../board-read.js';
import { agentDisplayName } from '../cli-context.js';
import { context } from '../cli-context.js';
import { idArg } from '../cli-context.js';
import { withBoard } from '../cli-context.js';
import { COORDINATOR } from '../config.js';
import { headCommit } from '../git.js';
import { laneNames } from '../lanes.js';
import { Refused } from '../refused.js';
import { mainRedReworkItems } from '../main-red.js';
import { nextReview } from '../next-review.js';
import { ownSessionReviews } from '../next-review.js';
import { trunkMerge } from '../trusted-policy.js';
import { relayLinked } from '../relay.js';
import { checkMainVerifier } from './verify.js';
import { ordered } from './claim.js';
import { claimOrdered } from './claim.js';
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
  // Select on a read-only board; only a claim, or a review reservation, opens it for writing (#1047).
  const looked = values.verify ? { claim: true } : withBoardRead(ctx, (board) => nextPick(ctx, board, values));
  if (!looked.claim) return looked;
  return await withBoard(ctx, async (board) => {
    if (values.verify) checkMainVerifier(ctx, board, values);
    if (values.verify) return nextReview(ctx, board, whoAmI(ctx, board), values, { ordered: (operation, args) => ordered(ctx, board, operation, operation === 'reopen' ? computedReturnArgs(board, args) : args), idArg, trunkMerge, listItems: store.listItems, itemById: store.itemById, getItem: store.getItem, mainRedReviewItems });
    const picked = nextPick(ctx, board, values);
    if (!picked.claim) return picked;
    const { me, item, held, shared, reasons, reviewSkipped, seats } = picked;
    const routed = seats ? await laneSeatContext(ctx, board, me, item, seats, context) : { context: ctx };
    const target = routed.context;
    const holder = whoAmI(target, board);
    ctx.io.nextPhase?.('claim', item.item_id);
    try {
      await claimOrdered(target, board, [item.item_id, { agentId: holder.id, lane: holder.lane, leaseMs: target.config.leaseMs, freeze: claimFreezer(target, board), head: headCommit(target.info.root), reviewSkipped }]);
    } catch (error) {
      if (error instanceof MainSpecMerged) return { retry: true, ...routed, specMerged: { item: item.item_id, rows: error.rows } };
      if (error instanceof Refused && ['HELD', 'ITEM_HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) return { retry: true, retryDetail: { phase: 'claim', item: item.item_id, code: error.code, message: error.message } };
      throw error;
    }
    return { item: store.getItem(board, item.item_id), shared, held, reviewSkipped, reasons, ...routed };
  });
}

/** The selection half of one next loop: the item to claim, or what to print instead. It only reads (#1047). */
function nextPick(ctx, board, values) {
  const me = whoAmI(ctx, board);
  const warm = warmFiles(ctx, board, me);
  const seats = nextSessionSeats(ctx, board);
  // A claim belongs to the seat that made it: seats of one session share its environment, so a sibling's claim is
  // never this seat's to resume or be pointed at (#958).
  const heldItem = seats ? store.listItems(board).find((item) => item.item_status === 'claimed'
    && item.item_parent_id === null && item.item_owner === me.id
    && store.ROUTES.indexOf(item.item_route) <= store.ROUTES.indexOf(me.route)) : undefined;
  const selection = { agentId: me.id, lane: me.lane, runnable: values.runnable, routes: values.routes, warm,
    priority: mainRedReworkItems(ctx.info.root, board), omitIds: values.omitIds ?? [], observeIdle: values.observeIdle };
  const own = heldItem ? { item: heldItem, reasons: [], shared: [] } : store.nextFor(board, selection);
  const picked = own.item || !seats ? own : store.nextFor(board, { ...selection,
    lanes: laneNames(ctx.config).filter(lane => lane !== COORDINATOR && lane !== me.lane) });
  const { item, reasons, shared } = picked;
  const held = item?.item_status === 'claimed';
  /** Offer only reviews this seat may give; a linked board previews its engine-27 verifier standing (#579). */
  const findOffer = () => store.reviewOffer(board, { agentId: me.id, lane: me.lane, policy: ctx.config.verify.policy,
    familyPolicy: ctx.config.verify.family, ratio: ctx.config.verify.reviewRatio, runnable: values.runnable, routes: values.routes,
    observeIdle: values.observeIdle, omitIds: values.omitIds ?? [], skipIds: ownSessionReviews(ctx.info, board, undefined, { listItems: store.listItems }), priority: mainRedReviewItems(ctx.info.root, board) });
  const offer = held ? null : relayLinked(ctx.info.root) ? store.withVerifierStanding(board, { root: true }, findOffer) : findOffer();
  if (offer?.item && !values.build && (offer.urgent || focusReviewFirst(board, offer.item, item, { milestones: store.milestones }))) return { item: offer.item, offer, build: item ?? null, reasons: focusReasons(board, offer.item, [], { milestones: store.milestones }) };
  if (!item) return { reasons, ...(values.observeIdle ? { idleReason: [picked.idleReason, !values.build && offer?.idleReason].find(reason => ['held', 'review-family', 'main-red'].includes(reason)) ?? picked.idleReason ?? 'unknown' } : {}), laneWork: ctx.info.isMain ? mainLaneWork(store.listItems(board)) : null };
  const reviewSkipped = values.build && !held
    ? { offeredItem: offer?.item?.item_id ?? null, ratio: offer?.ratio ?? ctx.config.verify.reviewRatio, ...store.reviewQueue(board) } : null;
  return { claim: true, me, item, held, shared, reasons, reviewSkipped, seats };
}

