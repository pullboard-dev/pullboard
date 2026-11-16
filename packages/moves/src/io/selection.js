/** @pullboard-module-loads packages/health/index.js */
/**
 * The selection half of `pullboard next`: one pick-and-claim loop over a read snapshot, then only the chosen item's
 * claim guards under the write [N2,V15,C7]. The command line app passes its board access, seat lookup and claim helpers
 * in as one ports object, so this cell never loads it.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mainPolicy } from '../../../sandbox/index.js';
import { trunkMerge } from '../../../sandbox/index.js';
import { UNBUILDABLE } from '../../../sandbox/index.js';
import { reportUnbuildableOnce } from '../../../sandbox/index.js';
import { recordedClaimWorktrees } from '../../../activity/index.js';
import { claimOverlapLines } from '../../../activity/index.js';
import { claimOverlaps } from '../../../items/index.js';
import { localDependencyIds } from '../../../items/index.js';
import { conflictRates } from '../../../items/index.js';
import { rejectionReturnEnabled } from '../../../store/index.js';
import { awaitingGateOrReview } from '../../../store/index.js';
import * as store from '../../../store/index.js';
import { agentSessionDigest } from '../../../person/index.js';
import { mainRedReviewItems } from '../../../landing/index.js';
import { computedReturnArgs } from '../../../landing/index.js';
import { mainRedReworkItems } from '../../../landing/index.js';
import { focusReviewFirst } from '../../../roadmap/index.js';
import { focusReasons } from '../../../roadmap/index.js';
import { milestoneFocus } from '../../../roadmap/index.js';
import { laneNames } from '../../../seats/index.js';
import { COORDINATOR } from '../../../config/index.js';
import { nextCapBuilders } from '../../../config/index.js';
import { nextReadinessCheck } from '../../../config/index.js';
import { headCommit } from '../../../git/index.js';
import { commandObservation } from '../../../git/index.js';
import { statusPaths } from '../../../git/index.js';
import { worktreeStatus } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { nextReview } from '../../../verify/index.js';
import { forcedLandedUnreviewed } from '../../../verify/index.js';
import { ownSessionReviews } from '../../../verify/index.js';
import { relayLinked } from '../../../link/index.js';
import { criterionFreezer } from './freezer.js';

/** The health cell loads only when a fresh claim shouts a stuck review cover [C7,#7081]. */
const requireModule = createRequire(import.meta.url);

/**
 * The command line functions one next loop calls: board access, the seat lookup, the claim and item-folder helpers.
 *
 * @typedef {{ withBoardRead: Function, withBoard: Function, whoAmI: Function, idArg: Function, ordered: Function,
 *   claimOrdered: Function, currentReworkRoutingPolicy: Function, MainSpecMerged: Function, checkMainVerifier: Function,
 *   dirtyFiles: Function, openItemFolder: Function, liveFolderRefusal: Function,
 *   mainLaneWork: Function, claimWorktreeSnapshot: Function }} NextPorts
 */

/**
 * The files an agent has been working in (N20): what its latest three items touched, and what is
 * uncommitted in its worktree now.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @param {NextPorts} ports
 * @returns {string[]}
 */
function warmFiles(ctx, board, me, { dirtyFiles }) {
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
 * @param {NextPorts} ports
 * @returns {Promise<{ item?: any, held?: boolean, retry?: boolean, reasons?: string[] }>}
 */
export async function nextOnce(ctx, values, ports) {
  const { withBoardRead, withBoard, whoAmI, idArg, ordered, claimOrdered, MainSpecMerged, checkMainVerifier,
    liveFolderRefusal, claimWorktreeSnapshot } = ports;
  if (!(values.verify && values.verifyId !== undefined)) {
    const ineligible = withBoardRead(ctx, board => store.ineligibleReleaseIds(board, whoAmI(ctx, board).id));
    values = { ...values, omitIds: [...new Set([...(values.omitIds ?? []), ...ineligible])] };
  }
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
      mainRedReviewItems, agentSessionDigest, landedOffer: (landedBoard, me, skips) => landedReviewFor(landedBoard, me, { ...skips, policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }),
    });
  });
  const looked = withBoardRead(ctx, (board) => nextSelection.pick(ctx, board, values, ports));
  if (looked.autoReview) {
    try { return { ...await nextOnce(ctx, { ...values, build: false, verify: true, verifyId: looked.autoReview.item_id, unstartedReviewLapse: true }, ports), review: true }; }
    catch (error) {
      if (error instanceof Refused && ['REVIEW_HELD', 'NOT_SUBMITTED'].includes(error.code)) return { retry: true,
        retryDetail: { phase: 'first-review reservation', item: looked.autoReview.item_id, code: error.code } };
      throw error;
    }
  }
  if (looked.move) {
    // This seat's lane has nothing it can take: the same seat, in the same worktree, re-joins the lane that has work and claims
    // there, so the claim is its own and releases from this worktree. A seat made with --lock-lane never gets here (GH #27).
    await withBoard(ctx, board => ordered(ctx, board, 'register', [{ lane: looked.move.lane, path: ctx.info.root, route: store.agentAt(board, ctx.info.root).agent_route, moveLane: true }]));
    ctx.io.say(`moved from ${looked.move.from} to ${looked.move.lane}: ${looked.move.from} had nothing you can take`);
    return { ...await nextOnce(ctx, { ...values, moved: true }, ports), moved: { from: looked.move.from, to: looked.move.lane } };
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
  // next.readinessCheck (off by default): an item whose readiness command exits non-zero is passed over and named [C7,#8793].
  const notReady = !held && nextReadinessCheck() ? readinessFailure(ctx, withBoardRead(ctx, board => store.getItem(board, looked.item.item_id))) : null;
  if (notReady) return { retry: true, skipItem: item.item_id, retryDetail: { phase: 'readiness', item: item.item_id, code: 'NOT_READY', message: notReady } };
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
      try { itemFolder = await openNextFolder(target, board, holder, item.item_id, {}, ports); }
      catch (error) {
        // A held claim whose folder another live session holds can be built neither there nor in the seat checkout:
        // this seat hands the claim back and selects again, so it is never sent to build in its seat checkout (#3691).
        if (!(error instanceof Refused) || !['ITEM_FOLDER_SESSION_LIVE', 'ITEM_FOLDER_UNFINISHED'].includes(error.code)) throw error;
        await ordered(target, board, 'release', [item.item_id, holder.id, `item folder cannot be used: ${error.message}`, 'OTHER']);
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
      if (!claim.renewed) await requireModule('../../../health/index.js').shoutReviewCoverStuck(target, board, ordered, holder);
    } catch (error) {
      if (error instanceof MainSpecMerged) return { retry: true, specMerged: { item: item.item_id, rows: error.rows } };
      if (error instanceof Refused && ['HELD', 'ITEM_HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) return { retry: true, retryDetail: { phase: 'claim', item: item.item_id, code: error.code, message: error.message } };
      // An item frozen under an older policy is passed over and named, so one stale item never stops the seat; claim by id
      // still refuses (#3770). The coordinator hears of it once per frozen bar, never once per next (#3793).
      if (error instanceof Refused && error.code === 'NO_POLICY' && STALE_POLICY.test(error.message)) {
        await reportStalePolicyOnce(target, board, item, holder, error.message, ordered);
        return { retry: true, skipItem: item.item_id, retryDetail: { phase: 'claim', item: item.item_id, code: error.code, message: error.message } };
      }
      // A bar naming a path missing from main, or a held check already green there, has nothing a builder can do: next
      // passes over it and the coordinator hears once per bar; claim by id still refuses (#5709).
      if (error instanceof Refused && UNBUILDABLE.has(error.code)) {
        await reportUnbuildableOnce(target, board, item, holder, error, ordered);
        target.io.say?.(`skipped #${item.item_id}: ${error.message}`);
        return { retry: true, skipItem: item.item_id, retryDetail: { phase: 'claim', item: item.item_id, code: error.code, message: error.message } };
      }
      throw error;
    }
    const itemFolder = await openNextFolder(target, board, holder, item.item_id, { renewed: item.renewed }, ports);
    return { item: store.getItem(board, item.item_id), shared, held, reviewSkipped, reasons,
      ...(lightReserved ? { lightReserved } : {}), ...(itemFolder ? { itemFolder, holder: holder.id } : {}) };
  });
}

/**
 * Run an item's readiness command in this seat's checkout; the failure line (command, exit code, output) or null when it
 * passes or the item has none. An unrunnable or hung command counts as failing, so next never offers an item that says it is not ready [C7,#8793].
 */
function readinessFailure(ctx, item) {
  const command = typeof item.item_readiness_command === 'string' ? item.item_readiness_command.trim() : '';
  if (!command) return null;
  const run = spawnSync(command, { shell: true, cwd: ctx.info.root, encoding: 'utf8', timeout: 30_000 });
  if (run.status === 0) return null;
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().slice(0, 300);
  return `readiness command \`${command}\` exited ${run.status ?? run.signal ?? run.error?.code}${output ? `: ${output}` : ''}`;
}

/** The claim refusals that name one item's frozen policy as stale; any other NO_POLICY still stops next. */
const STALE_POLICY = /accepted submit policy changed|no longer contains the frozen policy|is frozen against an older accepted policy/u;

/**
 * Tell the coordinator once that next passed over an item frozen against an older policy [B7,B25].
 *
 * Why: every seat's next skips the same item, so a note per call would flood the coordinator; a marker fact keyed on the
 * frozen digest keeps the report to one per frozen bar, and a refreeze (a new digest) is a new episode.
 */
async function reportStalePolicyOnce(ctx, board, item, holder, message, ordered) {
  const text = JSON.stringify({ staleFrozenPolicy: { digest: item.item_frozen_digest ?? null } });
  if (store.itemThread(board, item.item_id).some(entry => entry.type === 'fact' && entry.text === text)) return;
  try {
    await ordered(ctx, board, 'appendFact', [item.item_id, { agentId: holder.id, kind: 'note', text }]);
    await ordered(ctx, board, 'shout', [{ from: holder.id, to: COORDINATOR, lanes: [],
      text: `next passes over #${item.item_id} until it is refrozen: ${message.replace(/^\[NO_POLICY\] /u, '')}; pullboard refreeze ${item.item_id}` }]);
  } catch (error) {
    // A refused report must never stop the seat it only reports on.
    if (!/^[A-Z][A-Z_]+$/u.test(String(error?.code))) throw error;
  }
}

/**
 * Prepare the criterion only after the board's other claim guards have passed, exactly as the claim command freezes it.
 *
 * @param {any} ctx
 * @param {any} board
 * @returns {(item: any) => { text: string, digest: string }}
 */
function claimFreezer(ctx, board) {
  return item => criterionFreezer({ root: ctx.info.root, isMain: ctx.info.isMain, config: ctx.config }, { board })(item);
}

/**
 * The newest forced-landed item with no verdict that this seat may judge, or null: the builder, a refused route, policy or
 * family, and an item already under review are skipped with the guards `verify` itself applies to a landed item [C7,#6490].
 */
function landedReviewFor(board, me, { omitIds = [], skipIds = [], policy, familyPolicy } = {}) {
  const skip = new Set([...omitIds, ...skipIds]);
  const checks = store.reviewerChecks(board, { agentId: me.id, policy, familyPolicy, relaxationFor: () => null });
  return forcedLandedUnreviewed(store.listItems(board, { all: true }), item => store.events(board, { itemId: item.item_id })).find(item => !skip.has(item.item_id)
    && item.item_built_by !== me.id && ['notBuilder', 'routeAllows', 'policyAllows', 'requiredReviewFamily', 'familyAllows', 'reviewFree'].every(guard => !checks[guard]?.(item))) ?? null;
}

/** Preview reviews with current heartbeat observations; the atomic reservation repeats eligibility before writing. */
function reviewPreview(board, selection) {
  const reviewHeartbeats = new Map(store.listAgents(board).map(({ agent_id, heartbeatAt }) => [agent_id, heartbeatAt]));
  return store.nextFor(board, { ...selection, reviewHeartbeats });
}

/** Open the claimed item's own folder, or reuse the one a resumed claim already has, exactly as claim does [B5]. */
function openNextFolder(ctx, board, me, id, options, { openItemFolder, ordered }) {
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

/**
 * Open rework in another lane whose builder is still a seat in that lane and not gone: a conflict return or a reject
 * goes back to that builder, so a seat from another lane never moves over to take it [C7].
 * Why: a reviewer that took a returned head became one of its builders, so only the coordinator could review it (#7922).
 */
function builderRework(board, items, agents, me) {
  const seats = new Map(agents.map(agent => [agent.agent_id, agent.agent_lane]));
  return items.filter(item => item.item_status === 'open' && item.item_lane !== me.lane && item.item_built_by
    && item.item_built_by !== me.id && seats.get(item.item_built_by) === item.item_lane && !store.seatGone(board, item.item_built_by));
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
  pick: (ctx, board, values, ports) => nextPick(ctx, board, values, ports),
  /** Offer one review to this seat. */
  reviewOffer: (board, who) => store.reviewOffer(board, who),
  /** Find the one review the default loop offers before build work (deb8696e48). */
  defaultOffer: (board, selection) => store.nextFor(board, selection),
};

/**
 * Whether this seat's family may take the offered review only through the backlog family relaxation, the one
 * same-family path, which the reservation may still refuse SAME_FAMILY when its witness no longer holds (#3681).
 * Why: builders following next stopped at a same-family review they could not reserve while build work waited.
 */
function familyRelaxedOnly(ctx, board, me, item) {
  if (!item || item.item_status !== 'submitted') return false;
  const strict = store.reviewerChecks(board, { agentId: me.id, policy: ctx.config.verify.policy,
    familyPolicy: ctx.config.verify.family, relaxationFor: () => null });
  return Boolean(strict.familyAllows(item));
}

/** The selection half of one next loop: the item to claim, or what to print instead. It only reads (#1047). */
function nextPick(ctx, board, values, ports) {
  const { whoAmI, currentReworkRoutingPolicy, mainLaneWork } = ports;
  const me = whoAmI(ctx, board);
  const items = store.listItems(board), agents = store.listAgents(board);
  // Recorded by background maintenance: next runs no Git in another seat's worktree (#2427).
  const workingFiles = recordedClaimWorktrees(items, agents, board, { own: ctx.info.root });
  if (!values.defaultLoop) for (const line of claimOverlapLines(items, agents, me.id, claimOverlaps, workingFiles)) ctx.io.err(line);
  /** Offer only reviews this seat may give; a linked board previews its engine-27 verifier standing (#579). */
  const findOffer = () => values.defaultLoop
    ? (() => {
      const item = nextSelection.defaultOffer(board, { agentId: me.id, lane: me.lane, verify: true,
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
  // A review this seat's family can take only by relaxation never stands in front of build work (#3681).
  const familyOnly = familyRelaxedOnly(ctx, board, me, found?.item);
  // An eligible review, reserved for this seat or not, comes before its own held build: N41 takes the review, then the build (#7060, #7721).
  if (found?.mandatory && !values.build && !familyOnly) return { autoReview: found.item, item: found.item, reasons: [] };
  // A seat already holding a build continues it without selecting; only a starved review comes first (#2450, #2978).
  if (ownClaim && found?.urgent !== 'age' && !values.defaultLoop && !rejectionReturnEnabled(board) && ownClaim.item_parent_id === null && keepsClaim(me, ownClaim, values))
    return { claim: true, me, item: ownClaim, held: true, shared: [], reasons: [], reviewSkipped: null };
  const warm = warmFiles(ctx, board, me, ports);
  // queue.contention (off unless a project turns it on): the recent conflict rate of each file steers next [C7,#8527].
  const contention = ctx.config.queue?.contention === true ? { threshold: ctx.config.queue.contentionThreshold ?? 1,
    rates: conflictRates(store.eventsOfKinds(board, ['reopen', 'hold_item']), board.clock.now()) } : null;
  const selection = { buildBudgetMinutes: mainPolicy(ctx.info.root).config.itemBuildBudgetMinutes ?? 30, agentId: me.id, lane: me.lane, routeCap: me.route, runnable: values.runnable, routes: values.routes, warm,
    policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family,
    skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }),
    priority: mainRedReworkItems(ctx.info.root, board), omitIds: values.omitIds ?? [], observeIdle: values.observeIdle,
    reworkRoutingPolicy: currentReworkRoutingPolicy(ctx, board), workingFiles, ...(contention ? { contention } : {}), ...(ctx.config.next?.wholeItemsFirst === true ? { wholeItemsFirst: true } : {}) };
  const own = store.nextWithReleaseCooldown(board, selection, ctx.config.claims?.releaseCooldownMinutes ?? 30, store.nextFor, ctx.clock.now().getTime());
  // Other lanes are only named, never claimed (otherLaneWork), so the session this seat shares never decides what next serves (GH #27).
  // An empty look at other lanes never replaces this lane's own answer: its holds and skips are what the seat must read.
  const reworks = own.item ? [] : builderRework(board, items, agents, me);
  const elsewhere = own.item || ctx.info.isMain || ctx.io.personChannel === 'view' || ctx.io.personRequest ? null : store.nextFor(board, { ...selection,
    omitIds: [...selection.omitIds, ...reworks.map(entry => entry.item_id)], lanes: laneNames(ctx.config).filter(lane => lane !== COORDINATOR && lane !== me.lane) });
  const picked = elsewhere?.item ? elsewhere : own;
  const { item, reasons, shared, lightReserved } = picked;
  if (familyOnly && !item && found?.mandatory && !ownClaim && !values.build) return { autoReview: found.item, item: found.item, reasons: [] };
  const held = item?.item_status === 'claimed';
  // A seat holding a build still takes a starved review first: builders always hold a claim, so reviews waited (#2450).
  const offer = held && found?.urgent !== 'age' || familyOnly && item?.item_lane === me.lane ? null : found;
  const focus = milestoneFocus(board, { milestones: store.milestones });
  const findFocusedReview = () => store.nextFor(board, { agentId: me.id, lane: me.lane, verify: true,
    policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family, runnable: values.runnable, routes: values.routes,
    omitIds: values.omitIds ?? [], skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }), focusOnly: true });
  const focusedReview = focus && !held && !values.build
    ? relayLinked(ctx.info.root) ? store.withVerifierStanding(board, { root: true }, findFocusedReview) : findFocusedReview() : null;
  const focusOffer = focusedReview?.item && focus.ids.has(focusedReview.item.item_id)
    ? { item: focusedReview.item, queue: store.reviewQueue(board), ratio: ctx.config.verify.reviewRatio } : null;
  const selectedOffer = focusOffer ?? offer;
  // next.capBuilders (off by default): with that many other seats already holding claims, a build seat is offered the waiting review [C7,#8545].
  const cap = held || values.build ? 0 : nextCapBuilders();
  if (cap && selectedOffer?.item && new Set(items.filter(entry => entry.item_status === 'claimed' && entry.item_owner && entry.item_owner !== me.id).map(entry => entry.item_owner)).size >= cap)
    return { item: selectedOffer.item, offer: selectedOffer, build: item ?? null, buildHeld: false, reasons: [`${cap} builder seats already hold claims (next.capBuilders); reviewing instead of building`] };
  if (selectedOffer?.item && !values.build && !(rejectionReturnEnabled(board) && item?.item_verdict === 'REJECT' && item.item_built_by === me.id) && (focusOffer || held || (!focus || focus.ids.has(selectedOffer.item.item_id) || !item || !focus.ids.has(item.item_id)) && (selectedOffer.urgent || focusReviewFirst(board, selectedOffer.item, item, { milestones: store.milestones })))) return { item: selectedOffer.item, offer: selectedOffer, build: item ?? null, buildHeld: held, reasons: focusReasons(board, selectedOffer.item, [], { milestones: store.milestones }) };
  if (!item && reworks.length && !ctx.info.isMain) {
    const [first] = reworks;
    const nextStep = `#${first.item_id} went back to its builder ${first.item_built_by} for rework, so this seat leaves it to them: run pullboard next again once ${first.item_built_by} resubmits it`;
    return { reasons: [...(reasons ?? []), nextStep], nextStep, idleReason: 'nothing-eligible' };
  }
  if (!item) {
    const other = items.find(entry => entry.item_status === 'open' && (entry.item_lane !== me.lane
      || !store.ROUTES.includes(entry.item_route) || !store.ROUTES.includes(me.route) || !store.canTake(me.route, entry.item_route)));
    return { reasons: [...(reasons ?? []), ...(other ? [`#${other.item_id} is offered in ${other.item_lane} on the ${other.item_route} route; this seat leaves it unclaimed`] : [])],
      ...(values.observeIdle ? { idleReason: [picked.idleReason, !values.build && offer?.idleReason].find(reason => ['held', 'review-family', 'main-red'].includes(reason)) ?? picked.idleReason ?? 'unknown', skips: [...(!values.build ? offer?.skips ?? [] : []), ...(own.skips ?? []), ...(picked.skips ?? [])].filter((row, index, rows) => rows.findIndex(other => other.item === row.item) === index).slice(0, 3) } : {}), laneWork: ctx.info.isMain ? mainLaneWork(store.listItems(board)) : null };
  }
  const reviewSkipped = values.build && !held
    ? { offeredItem: offer?.item?.item_id ?? null, ratio: offer?.ratio ?? ctx.config.verify.reviewRatio, ...store.reviewQueue(board) } : null;
  if (item.item_lane !== me.lane) return values.moved || store.agentLaneLocked(board, me.id) ? otherLaneWork(me, item, reasons)
    : { move: { from: me.lane, lane: item.item_lane, item: item.item_id }, reasons: reasons ?? [] };
  if (!store.ROUTES.includes(me.route) || !store.ROUTES.includes(item.item_route) || !store.canTake(me.route, item.item_route))
    return { reasons: [...(reasons ?? []), `#${item.item_id} is available on the ${item.item_route} route; this seat serves ${me.route} and leaves it unclaimed`], idleReason: 'nothing-eligible' };
  if (!held && store.diagnoseWanted(board, item, me.route)) return { diagnose: item, reasons: reasons ?? [] };
  return { claim: true, me, item, held, shared, reasons, reviewSkipped, ...(lightReserved ? { lightReserved } : {}) };
}
