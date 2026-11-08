import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { recordedClaimWorktrees } from '../../../../../packages/activity/index.js';
import { claimOverlapLines } from '../../../../../packages/activity/index.js';
import { claimOverlaps } from '../../../../../packages/items/index.js';
import { claimWorktreeSnapshot } from '../../../../../src/untouched-claim-observation.js';
import { localDependencyIds } from '../../../../../packages/items/index.js';
import { rejectionReturnEnabled } from '../../../../../packages/store/index.js';
import { agentSessionDigest } from '../../../../../packages/person/index.js';
import { recoverOwnSubmitHandoffs } from '../submit-handoff.js';
import { awaitingGateOrReview } from '../../../../../packages/store/index.js';
import { reviewFamilyBuildPause } from '../../../../../packages/health/index.js';
/** Helpers for `pullboard next`: one pick-and-claim loop and its wait labels. Split from src/cli.js, which re-exports it [C7]. */
import { nextSessionSeats } from '../../../../../packages/seats/index.js';
import { sessionSeatReaders } from './seat-ports.js';
import { mainRedReviewItems } from '../../../../../packages/landing/index.js';
import { computedReturnArgs } from '../../../../../packages/landing/index.js';
import { focusReviewFirst } from '../../../../../packages/roadmap/index.js';
import { focusReasons } from '../../../../../packages/roadmap/index.js';
import { milestoneFocus } from '../../../../../packages/roadmap/index.js';
import { mainLaneWork } from '../next-steps.js';
import * as store from '../../../../../packages/store/index.js';
import { withBoardRead } from '../cli-context.js';
import { agentDisplayName } from '../cli-context.js';
import { idArg } from '../cli-context.js';
import { withBoard } from '../cli-context.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { laneNames } from '../../../../../packages/seats/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { mainRedReworkItems } from '../../../../../packages/landing/index.js';
import { nextReview } from '../../../../../packages/verify/index.js';
import { ownSessionReviews } from '../../../../../packages/verify/index.js';
import { trunkMerge } from '../../../../../packages/sandbox/index.js';
import { relayLinked } from '../../../../../packages/link/index.js';
import { checkMainVerifier } from './verify.js';
import { ordered } from './claim.js';
import { openItemFolder } from '../item-folder.js';
import { liveFolderRefusal } from '../item-folder.js';
import { claimOrdered } from './claim.js';
import { currentReworkRoutingPolicy } from './claim.js';
import { whoAmI } from './join.js';
import { MainSpecMerged } from './claim.js';
import { claimFreezer } from './claim.js';
import { dirtyFiles } from './submit.js';
import { commandObservation } from '../../../../../packages/git/index.js';
import { statusPaths } from '../../../../../packages/git/index.js';
import { worktreeStatus } from '../../../../../packages/git/index.js';

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
  // One next reads this seat's edits once, however many of its steps warm from them.
  // The command's shared status names the same edited and untracked paths as status --porcelain, without its quoting.
  let dirty;
  try { const { changed, untracked } = statusPaths(worktreeStatus(ctx.info.root)); dirty = [...changed, ...untracked]; }
  catch { dirty = commandObservation(JSON.stringify(['dirty-files', ctx.info.root]), () => dirtyFiles(ctx.info.root)); }
  return [...new Set([...recent, ...dirty])];
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
  if (!(values.verify && values.verifyId !== undefined)) {
    const ineligible = withBoardRead(ctx, board => store.ineligibleReleaseIds(board, whoAmI(ctx, board).id));
    values = { ...values, omitIds: [...new Set([...(values.omitIds ?? []), ...ineligible])] };
  }
  if (!values.verify) await recoverOwnSubmitHandoffs(ctx, withBoardRead(ctx, board => whoAmI(ctx, board)).id);
  if (!values.verify) {
    const waiting = withBoardRead(ctx, board => {
      const me = whoAmI(ctx, board);
      return store.ownershipWaiting(board, me.id === COORDINATOR ? COORDINATOR : me.lane);
    });
    if (waiting.length) return { ownershipWaiting: waiting };
  }
  // Select on a read-only board; only a claim, or a review reservation, opens it for writing (#1047).
  if (values.verify) return withBoardRead(ctx, board => {
    checkMainVerifier(ctx, board, values);
    return nextReview(ctx, board, whoAmI(ctx, board), values, {
      ordered: (operation, args) => withBoard(ctx, writable => ordered(ctx, writable, operation,
        operation === 'reopen' ? computedReturnArgs(writable, args) : args)),
      nextFor: reviewPreview,
      idArg, trunkMerge, listItems: store.listItems, itemById: store.itemById, getItem: store.getItem,
      mainRedReviewItems, agentSessionDigest,
    });
  });
  const looked = withBoardRead(ctx, (board) => nextSelection.pick(ctx, board, values));
  if (looked.autoReview) {
    try { return { ...await nextOnce(ctx, { ...values, build: false, verify: true, verifyId: looked.autoReview.item_id }), review: true }; }
    catch (error) {
      if (error instanceof Refused && ['REVIEW_HELD', 'NOT_SUBMITTED'].includes(error.code)) return { retry: true,
        retryDetail: { phase: 'first-review reservation', item: looked.autoReview.item_id, code: error.code } };
      throw error;
    }
  }
  if (!looked.claim) return looked;
  // The read snapshot chose the item: the write runs only its claim guards, and a guard refusal selects again on the
  // caller's next loop. Selecting again under the write lock held BOARD_BUSY for seconds (#2978).
  const { me: holder, held, shared, reasons, reviewSkipped, lightReserved } = looked;
  let item = looked.item;
  if (Number(values.wait) > 0 && !looked.held) {
    const current = withBoardRead(ctx, board => store.getItem(board, looked.item.item_id));
    if (current.item_status === 'open') return { ...looked, item: current, review: false, waitingOffer: true };
  }
  return await withBoard(ctx, async (board) => {
    // Claims belong to the seat that ran next, in its own item folder; next never routes a claim to another seat or opens one.
    const target = ctx;
    if (held) {
      // A claim made to wait after it was taken (pullboard edit --after) is parked, not served on every call: it is released
      // as waiting on the unmet items, its folder and branch stay, and the seat selects other work instead (#3723).
      const unmet = localDependencyIds(item).filter(id => !['verified', 'withdrawn'].includes(store.itemById(board, id)?.item_status));
      if (unmet.length) {
        await ordered(target, board, 'release', [item.item_id, holder.id,
          `waiting on ${unmet.map(id => `#${id}`).join(', ')} to be verified; parked by next, folder and branch kept`,
          { blockedOn: unmet, worktreeSnapshot: claimWorktreeSnapshot(target.info.root) }, 'BLOCKED']);
        return { retry: true, retryDetail: { phase: 'parked claim', item: item.item_id, code: 'WAITING', message: `#${item.item_id} waits on ${unmet.map(id => `#${id}`).join(', ')}` } };
      }
      let itemFolder;
      try { itemFolder = await openNextFolder(target, board, holder, item.item_id); }
      catch (error) {
        // A held claim whose folder another live session holds can be built neither there nor in the seat checkout:
        // this seat hands the claim back and selects again, so it is never sent to build in its seat checkout (#3691).
        if (!(error instanceof Refused) || error.code !== 'ITEM_FOLDER_SESSION_LIVE') throw error;
        await ordered(target, board, 'release', [item.item_id, holder.id, `item folder held by another live session: ${error.message}`, 'OTHER']);
        return { retry: true, retryDetail: { phase: 'held folder', item: item.item_id, code: error.code, message: error.message } };
      }
      return { item, held, shared, reviewSkipped, reasons,
        ...(lightReserved ? { lightReserved } : {}), ...(itemFolder ? { itemFolder, holder: holder.id } : {}) };
    }
    ctx.io.nextPhase?.('claim', item.item_id);
    // A folder another live session holds would refuse after the claim, and the same item would be picked again on
    // every next; the caller leaves it out and selects the next eligible item, while an explicit claim still refuses (#3688).
    const live = await liveFolderRefusal(target, board, holder, item.item_id);
    if (live) return { retry: true, skipItem: item.item_id,
      retryDetail: { phase: 'claim', item: item.item_id, code: live.code, message: live.message } };
    try {
      const claim = await claimOrdered(target, board, [item.item_id, { agentId: holder.id, lane: holder.lane, leaseMs: target.config.leaseMs, freeze: claimFreezer(target, board), head: headCommit(target.info.root), reviewSkipped, autoNext: true, itemFolder: true }]);
      item = { ...item, renewed: claim.renewed };
    } catch (error) {
      if (error instanceof MainSpecMerged) return { retry: true, specMerged: { item: item.item_id, rows: error.rows } };
      if (error instanceof Refused && ['HELD', 'ITEM_HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) return { retry: true, retryDetail: { phase: 'claim', item: item.item_id, code: error.code, message: error.message } };
      throw error;
    }
    const itemFolder = await openNextFolder(target, board, holder, item.item_id, { renewed: item.renewed });
    return { item: store.getItem(board, item.item_id), shared, held, reviewSkipped, reasons,
      ...(lightReserved ? { lightReserved } : {}), ...(itemFolder ? { itemFolder, holder: holder.id } : {}) };
  });
}

/** Preview reviews with current heartbeat observations; the atomic reservation repeats eligibility before writing. */
function reviewPreview(board, selection) {
  const reviewHeartbeats = new Map(store.listAgents(board).map(({ agent_id, heartbeatAt }) => [agent_id, heartbeatAt]));
  return store.nextFor(board, { ...selection, reviewHeartbeats });
}

/** Open the claimed item's own folder, or reuse the one a resumed claim already has, exactly as claim does [B5]. */
function openNextFolder(ctx, board, me, id, options = {}) {
  return openItemFolder(ctx, me, id, { board, ...options,
    onArchive: archive => ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note',
      text: `Archived prior item folder ${archive.previousPath} from ${archive.previousHolder} before takeover.\nRecovery: ${JSON.stringify({ directory: archive.directory, head: archive.manifest.head, ref: archive.manifest.ref })}`,
      ref: null }]) });
}

/** Name the best item in another lane without claiming it; that lane's own seat builds it [N2,B13]. */
function otherLaneWork(me, item, reasons) {
  const line = `#${item.item_id} (${item.item_title}) is next, in the ${item.item_lane} lane; this seat builds the ${me.lane} lane, so it stays unclaimed for a ${item.item_lane} seat: pullboard worktree ${item.item_lane} --model "<model name>"`;
  return { reasons: [...(reasons ?? []), line], idleReason: 'nothing-eligible', otherLane: { item: item.item_id, lane: item.item_lane } };
}

/** Whether this seat's own claim is one it may keep building here: its lane, route and runnable filter (#2978). */
function keepsClaim(me, item, values) {
  return item.item_lane === me.lane && store.ROUTES.includes(me.route) && store.ROUTES.includes(item.item_route)
    && store.canTake(me.route, item.item_route) && (values.routes ?? store.ROUTES).includes(item.item_route) && (!values.runnable || Boolean(item.item_check));
}

/**
 * The selection seam of one next loop: next selects once per loop, and tests count these calls (#2978).
 * Each entry forwards to the real board selection.
 */
export const nextSelection = {
  /** Select on one board snapshot. */
  pick: (ctx, board, values) => nextPick(ctx, board, values),
  /** Offer one review to this seat. */
  reviewOffer: (board, who) => store.reviewOffer(board, who),
};

/** The selection half of one next loop: the item to claim, or what to print instead. It only reads (#1047). */
function nextPick(ctx, board, values) {
  const me = whoAmI(ctx, board);
  const items = store.listItems(board), agents = store.listAgents(board);
  // Recorded by background maintenance: next runs no Git in another seat's worktree (#2427).
  const workingFiles = recordedClaimWorktrees(items, agents, board, { own: ctx.info.root });
  if (!values.defaultLoop) for (const line of claimOverlapLines(items, agents, me.id, claimOverlaps, workingFiles)) ctx.io.err(line);
  /** Offer only reviews this seat may give; a linked board previews its engine-27 verifier standing (#579). */
  const findOffer = () => values.defaultLoop
    ? (() => {
      const item = store.nextFor(board, { agentId: me.id, lane: me.lane, verify: true,
        policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family, runnable: values.runnable,
        routes: values.routes, observeIdle: values.observeIdle,
        skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }),
        priority: mainRedReviewItems(ctx.info.root, board) }).item;
      return item ? { item, mandatory: true, urgent: 'default-loop' } : null;
    })()
    : nextSelection.reviewOffer(board, { agentId: me.id, lane: me.lane, policy: ctx.config.verify.policy,
    familyPolicy: ctx.config.verify.family, starveMinutes: ctx.config.review?.starveMinutes ?? 5, ratio: ctx.config.verify.reviewRatio, runnable: values.runnable, routes: values.routes,
    observeIdle: values.observeIdle, omitIds: values.omitIds ?? [], skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }), priority: mainRedReviewItems(ctx.info.root, board) });
  // One offer serves both checks: a mandatory first review is what the full offer returns first (#2978).
  const found = relayLinked(ctx.info.root) ? store.withVerifierStanding(board, { root: true }, findOffer) : findOffer();
  const ownClaim = items.find(item => item.item_status === 'claimed' && item.item_owner === me.id && !(values.omitIds ?? []).includes(item.item_id) && !awaitingGateOrReview(board, item)
    && !(values.wait > 0 && store.submitHandoffFailure(board, item)));
  if (found?.mandatory && !ownClaim && !values.build) return { autoReview: found.item, item: found.item, reasons: [] };
  // A seat already holding a build continues it without selecting; only a starved review comes first (#2450, #2978).
  if (ownClaim && found?.urgent !== 'age' && !values.defaultLoop && !rejectionReturnEnabled(board) && ownClaim.item_parent_id === null && keepsClaim(me, ownClaim, values))
    return { claim: true, me, item: ownClaim, held: true, shared: [], reasons: [], reviewSkipped: null };
  const warm = warmFiles(ctx, board, me);
  const seats = nextSessionSeats(ctx, board, sessionSeatReaders);
  // A claim belongs to the seat that made it: seats of one session share its environment, so a sibling's claim is
  // never this seat's to resume or be pointed at (#958).
  const heldItem = seats ? store.listItems(board).find((item) => item.item_status === 'claimed'
    && item.item_parent_id === null && item.item_owner === me.id && !(values.omitIds ?? []).includes(item.item_id) && !awaitingGateOrReview(board, item)
    && !(values.wait > 0 && store.submitHandoffFailure(board, item))
    && store.ROUTES.indexOf(item.item_route) <= store.ROUTES.indexOf(me.route)) : undefined;
  const selection = { buildBudgetMinutes: mainPolicy(ctx.info.root).config.itemBuildBudgetMinutes ?? 30, agentId: me.id, lane: me.lane, routeCap: me.route, runnable: values.runnable, routes: values.routes, warm,
    policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family,
    skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }),
    priority: mainRedReworkItems(ctx.info.root, board), omitIds: values.omitIds ?? [], observeIdle: values.observeIdle,
    reworkRoutingPolicy: currentReworkRoutingPolicy(ctx, board), workingFiles };
  const own = heldItem && !rejectionReturnEnabled(board) ? { item: heldItem, reasons: [], shared: [] } : store.nextWithReleaseCooldown(board, selection, ctx.config.claims?.releaseCooldownMinutes ?? 30, store.nextFor, ctx.clock.now().getTime());
  const picked = own.item || !seats ? own : store.nextFor(board, { ...selection,
    lanes: laneNames(ctx.config).filter(lane => lane !== COORDINATOR && lane !== me.lane) });
  const { item, reasons, shared, lightReserved } = picked;
  const held = item?.item_status === 'claimed';
  // A seat holding a build still takes a starved review first: builders always hold a claim, so reviews waited (#2450).
  const offer = held && found?.urgent !== 'age' && !values.defaultLoop ? null : found;
  const focus = milestoneFocus(board, { milestones: store.milestones });
  const findFocusedReview = () => store.nextFor(board, { agentId: me.id, lane: me.lane, verify: true,
    policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family, runnable: values.runnable, routes: values.routes,
    omitIds: values.omitIds ?? [], skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }), focusOnly: true });
  const focusedReview = focus && !held && !values.build
    ? relayLinked(ctx.info.root) ? store.withVerifierStanding(board, { root: true }, findFocusedReview) : findFocusedReview() : null;
  const focusOffer = focusedReview?.item && focus.ids.has(focusedReview.item.item_id)
    ? { item: focusedReview.item, queue: store.reviewQueue(board), ratio: ctx.config.verify.reviewRatio } : null;
  const selectedOffer = focusOffer ?? offer;
  if (selectedOffer?.item && !values.build && !(rejectionReturnEnabled(board) && item?.item_verdict === 'REJECT' && item.item_built_by === me.id) && (focusOffer || held || (!focus || focus.ids.has(selectedOffer.item.item_id) || !item || !focus.ids.has(item.item_id)) && (selectedOffer.urgent || focusReviewFirst(board, selectedOffer.item, item, { milestones: store.milestones })))) return { item: selectedOffer.item, offer: selectedOffer, build: item ?? null, buildHeld: held, reasons: focusReasons(board, selectedOffer.item, [], { milestones: store.milestones }) };
  if (!item) {
    const other = items.find(entry => entry.item_status === 'open' && (entry.item_lane !== me.lane
      || !store.ROUTES.includes(entry.item_route) || !store.ROUTES.includes(me.route) || !store.canTake(me.route, entry.item_route)));
    return { reasons: [...(reasons ?? []), ...(other ? [`#${other.item_id} is offered in ${other.item_lane} on the ${other.item_route} route; this seat leaves it unclaimed`] : [])],
      ...(values.observeIdle ? { idleReason: [picked.idleReason, !values.build && offer?.idleReason].find(reason => ['held', 'review-family', 'main-red'].includes(reason)) ?? picked.idleReason ?? 'unknown', skips: [...(!values.build ? offer?.skips ?? [] : []), ...(own.skips ?? []), ...(picked.skips ?? [])].filter((row, index, rows) => rows.findIndex(other => other.item === row.item) === index).slice(0, 3) } : {}), laneWork: ctx.info.isMain ? mainLaneWork(store.listItems(board)) : null };
  }
  const reviewSkipped = values.build && !held
    ? { offeredItem: offer?.item?.item_id ?? null, ratio: offer?.ratio ?? ctx.config.verify.reviewRatio, ...store.reviewQueue(board) } : null;
  if (item.item_lane !== me.lane) return otherLaneWork(me, item, reasons);
  if (!store.ROUTES.includes(me.route) || !store.ROUTES.includes(item.item_route) || !store.canTake(me.route, item.item_route))
    return { reasons: [...(reasons ?? []), `#${item.item_id} is available on the ${item.item_route} route; this seat serves ${me.route} and leaves it unclaimed`], idleReason: 'nothing-eligible' };
  const coverPause = !held && reviewFamilyBuildPause(ctx.info, board, ctx.config, me);
  if (coverPause) return { reasons: [...(reasons ?? []), coverPause], idleReason: 'review-family' };
  if (!held && store.diagnoseWanted(board, item, me.route)) return { diagnose: item, reasons: reasons ?? [] };
  return { claim: true, me, item, held, shared, reasons, reviewSkipped, ...(lightReserved ? { lightReserved } : {}) };
}

