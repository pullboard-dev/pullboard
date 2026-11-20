import { lightDiagnosisProblem } from '../../logic/item/diagnosis.js';
import { QUEUE_PREEMPT_ENGINE } from '../../../../state/light.js';
import { EXPECTED_BUILD_ENGINE } from '../../../../state/light.js';
import { expectedBuildProblem } from '../../../../items/index.js';
import { liveClaimCollisions } from '../../../../items/index.js';
import {
  exitContinuationSummary,
  exitContinuationProblem,
} from "../../logic/exit/rules/continuation.js";
import { pendingSubmitHandoff } from "../submit/handoff/records.js";
import { submitHandoff } from "../submit/handoff/records.js";
import { firstRefusal } from "../../logic/board/item/lookup.js";
import { builderFamilyOf } from "../../../../verify/index.js";
import { familiesDiffer } from "../../../../verify/index.js";
import { prioritizeReviews } from "../../../../verify/index.js";
import { seatFamily } from "../../../../verify/index.js";
import { idleReason } from "../../../../seats/index.js";
import { liveRouteProblem } from "../../../../seats/index.js";
import { withLocalSeatPresence } from "../presence.js";
import { missingNeeds } from "../../../../queue/light.js";
import { agentAbilities } from "../needs.js";
import * as itemDependencies from "../../../../items/index.js";
import { criticalPathEnabled } from "../../../../items/index.js";
import { criticalPathOrder } from "../../../../items/index.js";
import { focusOrder } from "../../../../roadmap/index.js";
import { focusReasons } from "../../../../roadmap/index.js";
import { milestoneFocus } from "../../../../roadmap/index.js";
import { milestones } from "./read/shouts.js";
import { milestonePriorities } from "./read/shouts.js";
import { lineOrderEnabled } from "../../../../seats/index.js";
import { reviewerScarcity } from "../../../../seats/index.js";
import { current } from "./query.js";
import { itemById } from "./query.js";
import { itemThread } from "./query.js";
import { verdictsFor } from "./query.js";
import { listItems } from "./query.js";
import { listAgents } from "./query.js";
import { reviewHolder } from "./query.js";
import { laneHold } from "./query.js";
import { itemFiles } from "../../../../items/index.js";
import { itemFileCollisions } from "../../../../items/index.js";
import { contentionScores } from "../../../../items/index.js";
import { largestDisjointWave } from "../../../../items/index.js";
import { orderByContention } from "../../../../items/index.js";
import { itemCollisionPlan } from "../../../../items/index.js";
import { firstRefusalReason } from "../../../../items/index.js";
import { seatGone } from "../presence.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { CLAIM_RETURNS_ENGINE } from "../../../../state/index.js";
import { MILESTONE_RANK_ENGINE } from "../../../../state/index.js";
import { ROUTES } from "../../../../seats/index.js";
import { canTake } from "../../../../seats/index.js";
import { lightShaped } from "../../../../seats/index.js";
import { cappedRoute } from "../../../../seats/index.js";
import { routeOf } from "../../../../seats/index.js";
import { milestoneRanks } from "../../../../items/index.js";
import { foreignBlockers } from "../board.js";
import { reviewReleaseCooldown } from "../board.js";
import { parkedClaims } from "../cooldown.js";
import { reviewerChecks } from "../board.js";
import { reviewReleasedTwiceBy } from "./reserve/review.js";
import { reviewFamilyRelaxation } from './review/family.js';
import { refusesFamilyRelaxation } from './next-refused-pairings.js';
import { REVIEW_FAMILY_RELAX_ENGINE } from '../../../../state/light.js';
import { buildOrder } from "./order.js";
import { CLAIM_IDLE_ENGINE } from "../../../../state/light.js";
import { lineSettings } from "../../../../state/index.js";
import { rejectionReturnEnabled } from "../../logic/rework.js";
import { reworkFamilyRoute } from "../../logic/rework.js";
import { rejectedFirstEnabled } from "../../logic/rework.js";
import { isReturned } from "../../logic/rework.js";
import { FOCUS_BOUNDARY_ENGINE } from '../../../../state/index.js';
import { heldClaim } from '../claim.js';

/** Count each first eligibility refusal once; occupied reviews keep their separate lease diagnostics. */
function skippedReviewReasons(failures) {
  const groups = new Map();
  for (const failure of failures.values()) {
    if (!failure || failure.guard === 'reviewFree') continue;
    const { code, message } = failure.problem;
    const key = JSON.stringify([code, message]);
    const group = groups.get(key) ?? { code, count: 0, message };
    group.count++;
    groups.set(key, group);
  }
  const count = [...groups.values()].reduce((total, group) => total + group.count, 0);
  return count ? [`skipped ${count} submitted review${count === 1 ? '' : 's'} this seat cannot render`,
    ...[...groups.values()].map(group => `${group.count} ${group.code}: ${group.message}`)] : [];
}

/** Existing next-idle, auto-next claim and review reservation events identify active light seats. */
function recentLightActivity(board) {
  const cutoff = new Date(board.clock.now().getTime() - 30 * 60_000).toISOString();
  return Boolean(board.db.prepare(`SELECT 1 FROM event AS e JOIN agent AS a ON a.agent_id=e.event_by
    WHERE a.agent_route='light' AND e.event_at>=? AND (e.event_kind IN ('next-idle', 'reserve')
      OR (e.event_kind='claim' AND json_valid(e.event_detail)
        AND json_extract(e.event_detail, '$.autoNextSnapshot.head') IS NOT NULL)) LIMIT 1`).get(cutoff));
}

/**
 * A capable seat's pick that is light work with no current diagnosis, while a light seat is active, is offered as
 * 'diagnose #N' instead of claimed, so the capable seat writes the handoff and the light seat builds it (#2973).
 *
 * @param {any} board
 * @param {any} item the pick (an item row with its id and status), its route possibly lowered to mid by nextFor
 * @param {string} seatRoute
 * @returns {boolean}
 */
export function diagnoseWanted(board, item, seatRoute) {
  if (seatRoute === 'light' || item?.item_status !== 'open') return false;
  const stored = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(item.item_id);
  return Boolean(stored && lightDiagnosisProblem(board, stored) && recentLightActivity(board));
}

/**
 * The submitted items a review must not be offered while slices compose into their parent: every slice (an item with an item-slice row),
 * and each parent that still has a slice child open or claimed [C7,#11320].
 *
 * @param {any} board
 * @returns {Set<number>}
 */
function composeLandingReview(board) {
  const held = new Set();
  const slices = board.db.prepare("SELECT meta_key FROM board_meta WHERE meta_key GLOB 'item-slice:*'").all();
  for (const { meta_key: key } of slices) held.add(Number(key.slice('item-slice:'.length)));
  const unfinished = board.db.prepare(`SELECT DISTINCT item_parent_id AS parent FROM item WHERE item_parent_id IS NOT NULL AND item_status IN ('open', 'claimed')
    AND EXISTS (SELECT 1 FROM board_meta WHERE meta_key = 'item-slice:' || item.item_id)`).all();
  for (const { parent } of unfinished) held.add(parent);
  return held;
}

/**
 * The next item an agent can take (N2): for a builder, the oldest open item in its lane whose
 * dependencies are verified; for a verifier, the oldest submitted item it did not build. An agent
 * sees items at its tier and below, its own tier first, so lighter work waits for lighter models
 * while there is heavier work to do (B13). When nothing is free, the reasons say what everything
 * is waiting on.
 *
 * With `runnable`, only items that carry a check command, which an unattended runner needs; with
 * `routes`, only items on those routes, the ones a runner has an agent command for. With `warm`, the
 * files the agent worked in lately, an item that shares more of them comes first within its tier,
 * and `shared` names them (N20). A held lane offers nothing new (N22). A verifier is never offered `skipIds` (#973; engine 69, so older replays carry none).
 *
 * @param {any} board
 * @param {{ agentId: string, lane: string, verify?: boolean, policy?: string, familyPolicy?: string, runnable?: boolean, routes?: string[], warm?: string[], priority?: number[], lanes?: string[], skipIds?: number[], sessionIds?: number[], omitIds?: number[], afterRelease?: number, derivedGateAtHead?: (entry: any) => string | undefined, derivedSeatFamily?: (id: string) => string | undefined, composeLanding?: boolean }} options
 * @returns {{ item: any | null, reasons: string[], shared?: string[], blockers?: { item: number, waitsOn: number }[] }}
 */
export function nextFor(board, options) {
  const { agentId, lane, verify = false, policy = 'any', familyPolicy = 'off', familyRelaxAt,
    runnable = false, routes = ROUTES, warm = [], priority = [], lanes, skipIds: skippedIds = [], sessionIds = [], omitIds = [],
    afterRelease, observeIdle = false, reworkRoutingPolicy = null, workingFiles = new Map(),
    focusOnly = false, buildBudgetMinutes = 30, reviewOrder = null, routeFloor = null,
    routeCeiling = null, skipLightReserve = false, reviewHeartbeats = null, routeCap = null, contention = null, wholeItemsFirst = false, idleBlockers = false, lightShapedStrong = false, shapedIds = new Set(), derivedGateAtHead, derivedSeatFamily, composeLanding = false } = options;
  // `sessionIds` are the items this seat's own session authored: skipped like `skipIds`, and the only ones REVIEWER_SAME_SESSION names.
  const skipIds = [...new Set([...skippedIds, ...sessionIds])];
  const idleSkips = [];
  /** Keep the first real filter for each of the first three skipped candidates, without changing selection. */
  const skip = (entry, code) => { if (observeIdle && idleSkips.length < 3 && !idleSkips.some(row => row.item === entry.item_id)) idleSkips.push({ item: entry.item_id, code }); };
  /** With `idleBlockers`, up to three open items skipped as DEPENDENCY and the unverified item each waits on (#9619). */
  const blockers = [];
  /** Optional diagnostic data leaves historical query result shapes and all selection guards unchanged. */
  const empty = (reason, result) => {
    const base = observeIdle ? { ...result, idleReason: reason, ...(idleSkips.length ? { skips: [...idleSkips] } : {}) } : result;
    return idleBlockers ? { ...base, blockers: [...blockers] } : base;
  };
  const focusCompare = focusOrder(board, () => 0, { milestones });
  const focus = (board.executionEngineVersion ?? ENGINE_VERSION) >= FOCUS_BOUNDARY_ENGINE ? milestoneFocus(board, { milestones }) : null;
  const overflow = focus?.overflow === true;
  /**
   * The idle answer under a focus with overflow off. A seat whose route sits below some submitted focus items names them and says
   * a stronger seat reviews them, instead of "nothing is free" (#3102); it never reserves them, since `items` already leaves them out.
   */
  const focusIdle = () => {
    const above = !verify ? [] : listItems(board).filter(entry => entry.item_status === 'submitted' && focus.ids.has(entry.item_id)
      && entry.item_built_by !== agentId && !omitIds.includes(entry.item_id) && !canTake(route, entry.item_route));
    const waiting = above.length ? `${above.map(entry => `#${entry.item_id}`).join(', ')} wait${above.length === 1 ? 's' : ''} for a ${[...new Set(above.map(entry => entry.item_route))].join(' or ')} seat to review; ` : '';
    return empty('focus', { item: null, reasons: [`${focus.name} is in focus; ${waiting}nothing is free for you; overflow is off.`] });
  };
  const restrictFocus = focus && (!overflow || focusOnly);
  const otherFocusedWork = () => {
    if (!focus || !overflow || focusOnly) return false;
    const item = nextFor(board, { ...options, verify: !verify, focusOnly: true }).item;
    return Boolean(item && focus.ids.has(item.item_id));
  };
  // A session that declared a lighter model than its seat joined with is offered only its own route (#3678).
  const route = cappedRoute(routeOf(board, agentId), routeCap);
  const tier = (entry) => ROUTES.indexOf(entry.item_route);
  // An open item names the abilities it needs [U136,#1888]; a seat lacking one is never offered it. One read for the whole board, not one per item (#5329).
  const abilities = new Set(agentAbilities(board, agentId));
  const neededBy = new Map(board.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key LIKE 'item\\_needs:%' ESCAPE '\\'").all()
    .map(row => [Number(row.meta_key.slice('item_needs:'.length)), JSON.parse(row.meta_value)]));
  const lacksAbility = (entry) => entry.item_status === 'open' && neededBy.has(entry.item_id) && missingNeeds(neededBy.get(entry.item_id), [...abilities]).length > 0;
  const allItems = listItems(board).reverse().map(entry => lightDiagnosisProblem(board, entry) ? { ...entry, item_route: 'mid' } : entry);
  if (observeIdle) for (const entry of allItems) {
    if (entry.item_status !== (verify ? 'submitted' : 'open') || !verify && !(lanes ?? [lane]).includes(entry.item_lane)) continue;
    if (omitIds.includes(entry.item_id)) skip(entry, 'OMITTED');
    else if (!canTake(route, entry.item_route) || !routes.includes(entry.item_route)) skip(entry, 'ROUTE_FILTER');
    else if (lacksAbility(entry)) skip(entry, 'NEEDS_ABILITY');
    else if (runnable && !entry.item_check) skip(entry, 'CHECK_REQUIRED');
    else if (verify && entry.item_built_by === agentId) skip(entry, 'SELF_VERIFY');
    else if (verify && skipIds.includes(entry.item_id)) skip(entry, 'SELF_SESSION_VERIFY');
  }
  const items = allItems
    .filter((entry) => !omitIds.includes(entry.item_id) && (canTake(route, entry.item_route) || shapedIds.has(entry.item_id)) && routes.includes(entry.item_route) && (!runnable || entry.item_check) && !lacksAbility(entry)
      && (entry.item_status !== 'open' || routeFloor === null || tier(entry) >= routeFloor)
      && (entry.item_status !== 'open' || routeCeiling === null || tier(entry) <= routeCeiling))
    .sort((first, second) => tier(second) - tier(first));
  if (!verify && !skipLightReserve && route !== 'light' && routeFloor === null && recentLightActivity(board)) {
    // First use the ordinary readiness checks on this seat's route and higher. Only if that
    // produces work do we report a ready light item as deliberately kept for a light seat.
    const preferred = nextFor(board, { ...options, routeFloor: ROUTES.indexOf(route), skipLightReserve: true });
    if (preferred.item) {
      const light = nextFor(board, { ...options, routeFloor: ROUTES.indexOf('light'), routeCeiling: ROUTES.indexOf('light'), skipLightReserve: true });
      return light.item?.item_status === 'open' && light.item.item_id !== preferred.item.item_id
        ? { ...preferred, lightReserved: light.item } : preferred;
    }
  }
  // next.lightShapedStrong (off unless a project turns it on): a light seat finding no free item is offered an open light-shaped strong item [C7,#9568].
  if (!verify && lightShapedStrong && route === 'light') {
    const plain = nextFor(board, { ...options, lightShapedStrong: false });
    if (plain.item) return plain;
    const shaped = new Set(allItems.filter(entry => entry.item_status === 'open' && entry.item_route === 'strong' && lightShaped(entry)).map(entry => entry.item_id));
    return shaped.size ? nextFor(board, { ...options, lightShapedStrong: false, shapedIds: shaped }) : plain;
  }
  const tiers = route === 'strong' ? '' : `${ROUTES.slice(0, ROUTES.indexOf(route) + 1).reverse().join(' or ')} `;
  const routed = `${tiers}${runnable ? 'runnable ' : ''}`;
  if (verify) {
    // With a derived seat-family answer, a seat it names takes that family and a builder it names takes its answer; any other id is computed as before [C7,#11383].
    const family = derivedSeatFamily?.(agentId) ?? seatFamily(board, agentId);
    const builderFamily = (entry) => {
      const derived = entry.item_built_by ? derivedSeatFamily?.(entry.item_built_by) : undefined;
      return derived ?? builderFamilyOf(board, entry);
    };
    const hasDifferentFamily = (entry) => familiesDiffer(board, family, builderFamily(entry));
    // slices.composeLanding (off unless a project turns it on): a submitted slice is never offered, and its submitted parent only once no slice child is still open or claimed [C7,#11320].
    const composed = composeLanding ? composeLandingReview(board) : null;
    const unrelated = items.filter((entry) => entry.item_status === 'submitted' && entry.item_built_by !== agentId && !skipIds.includes(entry.item_id) && !composed?.has(entry.item_id));
    const enabled = (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_FAMILY_RELAX_ENGINE;
    // One selection shares its queue reads; authoritative reservations derive their witness afresh.
    const relaxationCache = new Map();
    const baseChecks = reviewerChecks(board, { agentId, policy, familyPolicy, reviewHeartbeats, ...(enabled ? { relaxationFor: refusesFamilyRelaxation(board, agentId) ? () => null : item => reviewFamilyRelaxation(board, item, agentId, familyRelaxAt, policy, familyPolicy, relaxationCache, reviewHeartbeats) } : {}) });
    // A family that released a review twice is never offered it again, so next --verify does not loop on the refusal (REVIEW_RELEASE_TWICE_ENGINE).
    const checks = { ...baseChecks, reviewNotReleasedTwiceByFamily: entry => reviewReleasedTwiceBy(board, entry.item_id, agentId) };
    /** Use the native reservation/verdict guard order, preserving its first refusal and short circuit. */
    function failure(entry) {
      for (const [guard, check] of Object.entries(checks)) {
        const problem = check(entry);
        if (problem) return { guard, problem };
      }
      return null;
    }
    const failures = new Map(unrelated.map(entry => [entry, failure(entry)]));
    for (const [entry, failed] of failures) if (failed) skip(entry, failed.problem.code);
    const skipped = skippedReviewReasons(failures);
    /** Retain eligibility diagnostics whether selection succeeds, waits or has no candidate. */
    const reviewResult = result => ({ ...result, reasons: [...skipped, ...result.reasons] });
    const standingRefusal = [...failures.values()].find(value => ['notBuilder', 'familyAllows'].includes(value?.guard))?.problem;
    const requiredRefusals = [...failures.values()].filter(value => value?.guard === 'requiredReviewFamily').map(value => value.problem);
    // Keep other holders only for the existing diagnostic; they can never become selected work.
    const reviewable = unrelated.filter(entry => !failures.get(entry) || failures.get(entry).guard === 'reviewFree');
    if (familyPolicy === 'prefer') reviewable.sort((first, second) => Number(hasDifferentFamily(second)) - Number(hasDifferentFamily(first)));
    const candidates = reviewable.map((entry) => ({
      entry,
      holder: reviewHolder(board, entry, reviewHeartbeats),
      problem: failures.get(entry)?.problem,
      cooldown: reviewReleaseCooldown(board, entry.item_id, agentId),
    }));
    const heldByMe = candidates.find((candidate) => candidate.holder === agentId)?.entry;
    if (heldByMe) return reviewResult({ item: heldByMe, reasons: [] });
    const presenceProblem = liveRouteProblem(board, agentId, { withLocalSeatPresence });
    if (presenceProblem) return reviewResult(empty('unknown', { item: null, reasons: [presenceProblem] }));
    const milestonePriority = milestonePriorities(board);
    const rank = milestoneRanks(board, milestonePriority, { milestones });
    const scarcity = lineOrderEnabled(board) ? reviewerScarcity(board, candidates.map(candidate => candidate.entry), (entry, reviewer) =>
      Object.values(reviewerChecks(board, { agentId: reviewer, policy, familyPolicy, reviewHeartbeats })).every(guard => !guard(entry)), { listAgents }) : null;
    const lineCompare = scarcity ? buildOrder(board, { agentId }) : null;
    const previousOrder = (first, second) => scarcity ? scarcity.get(first.item_id) - scarcity.get(second.item_id)
      || lineCompare(first, second) : milestonePriority(first) - milestonePriority(second)
      || rank(first) - rank(second);
    const focus = milestoneFocus(board, { milestones });
    const group = item => focus?.ids.has(item.item_id) ? -1 : milestonePriority(item);
    // The path counts unfinished items and the overlap counts in-flight ones, so landed and withdrawn history is never read [C7,#10795].
    const pathItems = () => { const open = listItems(board), ids = new Set(open.map(entry => entry.item_id)); return [...open, ...listItems(board, { inFlight: true }).filter(entry => !ids.has(entry.item_id))]; };
    const order = criticalPathEnabled(board) ? criticalPathOrder({ items: pathItems(), group, fallback: previousOrder }) : previousOrder;
    candidates.sort((first, second) => order(first.entry, second.entry));
    prioritizeReviews(board, candidates, priority, focusCompare);
    if (reviewOrder) candidates.sort((a, b) => {
      const first = reviewOrder.get(a.entry.item_id), second = reviewOrder.get(b.entry.item_id);
      return (first?.at ?? Infinity) - (second?.at ?? Infinity)
        || (first?.sequence ?? Infinity) - (second?.sequence ?? Infinity) || a.entry.item_id - b.entry.item_id;
    });
    if (focus) candidates.sort((a, b) => focusCompare(a.entry, b.entry));
    for (const candidate of candidates) {
      if (candidate.cooldown) skip(candidate.entry, 'REVIEW_RELEASE_COOLDOWN');
      else if (restrictFocus && !focus.ids.has(candidate.entry.item_id) && (focusOnly || !greenAtHead(board, candidate.entry))) skip(candidate.entry, 'FOCUS_BOUNDARY');
    }
    const item = candidates.find((candidate) => !candidate.problem && !candidate.holder && !candidate.cooldown
      && (!restrictFocus || focus.ids.has(candidate.entry.item_id) || !focusOnly && greenAtHead(board, candidate.entry)))?.entry;
    if (item && (!focus || focus.ids.has(item.item_id) || !otherFocusedWork())) return reviewResult({ item, reasons: focusReasons(board, item, [], { milestones }) });
    if (focus && !overflow) return reviewResult(focusIdle());
    if (item) return reviewResult(empty('focus', { item: null, reasons: [`${focus.name} has focused work available in the other mode.`] }));
    const held = candidates.filter((candidate) => candidate.holder && candidate.holder !== agentId)
      .map(({ entry, holder: reviewer }) => `${reviewer} holds the review of #${entry.item_id} until ${entry.item_review_until}`);
    const cooling = candidates.filter((candidate) => candidate.cooldown)
      .map(({ entry, cooldown }) => `you released the review of #${entry.item_id}; try again after ${cooldown}, or let another reviewer take it`);
    // Every submission left out only because this seat's session built it: name it so the coordinator adds a seat from another session.
    const sameSession = items.filter((entry) => entry.item_status === 'submitted' && entry.item_built_by !== agentId
      && (sessionIds.includes(entry.item_id) || failures.get(entry)?.problem?.code === 'SELF_SESSION_VERIFY'))
      .map((entry) => `REVIEWER_SAME_SESSION: #${entry.item_id} was built under this seat's parent session, so it is never offered here; the coordinator adds a reviewer seat from another session`);
    return reviewResult(empty(held.length || cooling.length ? 'held' : requiredRefusals.length || standingRefusal?.code?.includes('FAMILY') ? 'review-family' : standingRefusal ? 'unknown' : 'nothing-eligible', { item: null, reasons: [`nothing ${routed}submitted that you did not build${held.length ? ' and no other agent is reviewing' : ''}`,
      ...(standingRefusal ? [standingRefusal.message] : []), ...requiredRefusals.map(error => error.message), ...held, ...cooling, ...sameSession] }));
  }
  const held = heldClaim(board, agentId, { items });
  // Read-only build planning may disregard exactly this caller's claim; the ordered claim transition still enforces ONE_CLAIM.
  const plannedRelease = held && held.item_id === afterRelease ? held.item_id : null;
  const ownRejectionFirst = held && plannedRelease === null && rejectionReturnEnabled(board)
    && items.some(entry => entry.item_status === 'open' && entry.item_verdict === 'REJECT' && entry.item_built_by === agentId);
  if (held && plannedRelease === null && !ownRejectionFirst) return { item: held, reasons: [] };
  const presenceProblem = liveRouteProblem(board, agentId, { withLocalSeatPresence });
  if (presenceProblem) return ownRejectionFirst ? { item: held, reasons: [presenceProblem] } : empty('unknown', { item: null, reasons: [presenceProblem] });
  const selectedLanes = new Set(lanes ?? [lane]);
  const reasons = allItems.filter((entry) => entry.item_status === 'open' && selectedLanes.has(entry.item_lane) && entry.item_hold_reason)
    .map((entry) => `#${entry.item_id} is held by coordinator: ${entry.item_hold_reason}`);
  const paused = laneHold(board, lane);
  if (!lanes && paused) {
    const heldReasons = [`${paused.hold_by} holds the ${lane} lane: ${paused.hold_reason}`, ...reasons];
    return ownRejectionFirst ? { item: held, reasons: heldReasons } : empty('held', { item: null, reasons: heldReasons });
  }
  if (lanes) for (const name of selectedLanes) {
    const hold = laneHold(board, name);
    if (hold) { selectedLanes.delete(name); reasons.push(`${hold.hold_by} holds the ${name} lane: ${hold.hold_reason}`); }
  }
  const compare = buildOrder(board, { warm, agentId, tierFirst: true });
  // Only claimed, submitted and unmerged verified items can collide: the landed and withdrawn history is never read [C7,#10795].
  const inFlight = listItems(board, { inFlight: true }).filter(entry => entry.item_id !== plannedRelease && (!ownRejectionFirst || entry.item_id !== held.item_id))
    .map(entry => ({ ...entry, item_files: [entry.item_files, ...(workingFiles.get(entry.item_id)?.files ?? [])].filter(Boolean).join('\n') }));
  const recent = new Set(warm);
  const mainRed = new Set(priority);
  const laneItems = items.filter((entry) => entry.item_status === 'open' && selectedLanes.has(entry.item_lane)
    && (!ownRejectionFirst || entry.item_verdict === 'REJECT' && entry.item_built_by === agentId));
  const mine = laneItems
    // The listed row carries the hold: a full getItem per open item cost next 190 ms on a 2,500-item board (#5329).
    .filter((entry) => { const held = Boolean(entry.item_hold_reason); if (held) skip(entry, 'ITEM_HELD'); return !held; })
    .map((entry, order) => ({ entry, order, shared: recent.size ? itemFiles(entry).filter((path) => recent.has(path)) : [] }))
    .sort((first, second) => compare(first.entry, second.entry));
  const familyRework = lineSettings(board).reworkSameFamily === true;
  if (familyRework || rejectionReturnEnabled(board)) for (const candidate of mine) {
    if (firstRefusal(board, candidate.entry.item_id)?.otherSeatFirst) continue;
    const routing = reworkFamilyRoute(board, candidate.entry, { listAgents, routeOf, canTake,
      seatFamily: board.nativePorts.seatFamily, canonicalFamily: board.nativePorts.canonicalFamily, policy: reworkRoutingPolicy });
    if (routing.applies) candidate.reworkRouting = routing;
  }
  // Move only evidenced reworks ahead of their own tier; with no evidence, normal order is exact.
  for (const route of lineOrderEnabled(board) ? [] : ROUTES) {
    const routeTier = ROUTES.indexOf(route);
    const selected = mine.findIndex(({ entry }) => tier(entry) === routeTier && mainRed.has(entry.item_id));
    const firstTierItem = mine.findIndex(({ entry }) => tier(entry) === routeTier);
    if (selected > firstTierItem && firstTierItem >= 0) {
      // Explicit coordinator order leads automatic rework; never-ranked boards retain their old path.
      if ((board.executionEngineVersion ?? ENGINE_VERSION) >= MILESTONE_RANK_ENGINE && milestones(board).some(entry => entry.order?.length)) {
        const position = milestonePriorities(board);
        const rank = milestoneRanks(board, position, { milestones });
        const first = mine[firstTierItem].entry;
        const selectedItem = mine[selected].entry;
        if (position(first) !== position(selectedItem) || rank(first) !== rank(selectedItem)) continue;
      }
      const [rework] = mine.splice(selected, 1);
      mine.splice(firstTierItem, 0, rework);
    }
  }
  mine.sort((a, b) => focusCompare(a.entry, b.entry));
  mine.sort((a, b) => Number(Boolean(b.reworkRouting?.rejection) && b.entry.item_built_by === agentId) - Number(Boolean(a.reworkRouting?.rejection) && a.entry.item_built_by === agentId));
  // Rejected or reopened work leads new work for every seat, its builder's own first: a preference, never a reservation (#5765).
  if (rejectedFirstEnabled(board)) {
    const back = new Map(mine.map(({ entry }) => [entry.item_id, isReturned(board, entry) ? 1 + Number(entry.item_built_by === agentId) : 0]));
    mine.sort((a, b) => back.get(b.entry.item_id) - back.get(a.entry.item_id));
  }
  if (focus) mine.sort((a, b) => focusCompare(a.entry, b.entry));
  // next.wholeItemsFirst (off unless a project turns it on): a whole item of the focused release leads every open slice [C7,#8811].
  if (focus && wholeItemsFirst) {
    const slice = ({ entry }) => board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`item-slice:${entry.item_id}`) ? 1 : 0;
    const wholeFocused = ({ entry }) => focus.ids.has(entry.item_id) && !slice({ entry });
    mine.sort((a, b) => Number(wholeFocused(b)) - Number(wholeFocused(a)));
  }
  // Work this seat parked while it waited comes back to it before other open items once the wait ends (#3723).
  const parked = parkedClaims(board, agentId);
  if (parked.size) mine.sort((a, b) => Number(parked.has(b.entry.item_id)) - Number(parked.has(a.entry.item_id)));
  // An open item whose last gate went red at its own head has a builder's work in it and no seat holding it: it goes to
  // the next eligible seat ahead of never-built items, so a red never waits for luck (#4014).
  const redUnowned = new Set(mine.filter(({ entry }) => redGateWithoutHolder(board, entry)).map(({ entry }) => entry.item_id));
  if (redUnowned.size) mine.sort((a, b) => Number(redUnowned.has(b.entry.item_id)) - Number(redUnowned.has(a.entry.item_id)));
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= QUEUE_PREEMPT_ENGINE) {
    const emergency = new Set([...priority, ...board.db.prepare("SELECT meta_key FROM board_meta WHERE meta_key GLOB 'item_urgent:*' AND meta_value='on'").all()
      .map(row => Number(row.meta_key.slice('item_urgent:'.length)))]);
    mine.sort((a, b) => Number(emergency.has(b.entry.item_id)) - Number(emergency.has(a.entry.item_id)));
  }
  // queue.contention: among equal-priority work the least contended item leads, and a hot one waits [C7,#8527].
  const hot = contention ? contentionScores(mine.map(({ entry }) => entry), inFlight, contention.rates) : null;
  if (hot) {
    const position = milestonePriorities(board);
    const urgent = new Set([...priority, ...board.db.prepare("SELECT meta_key FROM board_meta WHERE meta_key GLOB 'item_urgent:*' AND meta_value='on'").all().map(row => Number(row.meta_key.slice('item_urgent:'.length)))]);
    const alone = ({ entry, reworkRouting }) => urgent.has(entry.item_id) || redUnowned.has(entry.item_id) || parked.has(entry.item_id) || Boolean(reworkRouting?.rejection) || rejectedFirstEnabled(board) && isReturned(board, entry);
    orderByContention(mine, candidate => alone(candidate) ? `#${candidate.entry.item_id}` : `${tier(candidate.entry)}|${position(candidate.entry)}|${focus?.ids.has(candidate.entry.item_id)}`, hot);
  }
  // queue.contention: of the ready items no claimed or submitted item shares a file with, only the largest disjoint wave is offered [C7,#1440].
  const ready = hot ? mine.map(({ entry }) => entry).filter(entry => hot.get(entry.item_id).score < contention.threshold
    && itemDependencies.localDependencyIds(entry).every(id => ['verified', 'withdrawn'].includes(current(board, itemById(board, id)).item_status))
    && !itemFileCollisions(entry, inFlight).length) : [];
  const wave = hot ? new Set(largestDisjointWave(ready)) : null;
  const waveFiles = wave ? new Set(ready.filter(entry => wave.has(entry.item_id)).flatMap(entry => itemFiles(entry))) : null;
  const readyIds = new Set(ready.map(entry => entry.item_id));
  const overlapping = [];
  for (const { entry, shared, reworkRouting: rework } of mine) {
    if (restrictFocus && !focus.ids.has(entry.item_id)) { skip(entry, 'FOCUS_BOUNDARY'); continue; }
    const diagnosisProblem = route === 'light' ? lightDiagnosisProblem(board, entry, 'light') : null;
    if (diagnosisProblem) { skip(entry, diagnosisProblem.code); reasons.push(diagnosisProblem.message); continue; }
    // A derived answer is trusted only when it names a reason; no answer computes the gate as before, so a newer gate is never missed [C7].
    const derived = derivedGateAtHead?.(entry);
    const gated = typeof derived === 'string' ? derived : gateAtHead(board, entry);
    if (gated) { skip(entry, 'GATE_AT_HEAD'); reasons.push(`#${entry.item_id}: ${gated}; nothing to build`); continue; }
    const scopeProblem = (board.executionEngineVersion ?? ENGINE_VERSION) >= EXPECTED_BUILD_ENGINE ? expectedBuildProblem(entry, buildBudgetMinutes) : null;
    if (scopeProblem) { skip(entry, scopeProblem.code); reasons.push(`${scopeProblem.message}; ${scopeProblem.next ?? ''}`); continue; }
    const waiting = itemDependencies.localDependencyIds(entry)
      .map((id) => current(board, itemById(board, id)))
      .filter((before) => before.item_status !== 'verified' && before.item_status !== 'withdrawn');
    const continuation = exitContinuationProblem(board, entry.item_id, agentId);
    if (continuation) { skip(entry, continuation.code); reasons.push(continuation.message); continue; }
    if (rework && rework.allowed !== null && !rework.allowed.includes(agentId)) {
      skip(entry, 'REWORK_ROUTING');
      reasons.push(rework.mode === 'policy-unknown' ? `#${entry.item_id} waits for accepted takeover and maintenance policy` : `#${entry.item_id} is reserved for ${rework.mode === 'builder' ? rework.builder : `the ${rework.builderFamily} family`}`);
      continue;
    }
    const reserved = rework ? null : firstRefusalReason(board, entry.item_id, agentId, { firstRefusal, otherBuilderFirst: (board.executionEngineVersion ?? ENGINE_VERSION) >= CLAIM_RETURNS_ENGINE, offering: true, seatGone });
    if (reserved) { skip(entry, 'FIRST_REFUSAL'); reasons.push(reserved); continue; }
    if (hot && hot.get(entry.item_id).score >= contention.threshold) {
      const { file, score } = hot.get(entry.item_id);
      skip(entry, 'CONTENTION'); reasons.push(`#${entry.item_id} waits on ${file}: contention ${score} reaches ${contention.threshold}; changes in flight on it land first`); continue;
    }
    if (wave && readyIds.has(entry.item_id) && !wave.has(entry.item_id)) {
      const file = itemFiles(entry).find(path => waveFiles.has(path));
      skip(entry, 'WAVE'); reasons.push(`#${entry.item_id} waits on ${file}: it shares the file with an item in this wave of disjoint work`); continue;
    }
    const functionPlan = itemCollisionPlan(board, entry, inFlight, workingFiles);
    const collisions = functionPlan?.blockers ?? [...new Set([...itemFileCollisions(entry, inFlight), ...liveClaimCollisions(entry, inFlight, workingFiles)])];
    if (collisions.length) { skip(entry, 'COLLISION'); reasons.push(...collisions); overlapping.push({ entry, shared, collisions, functionPlan, rework, waiting }); continue; }
    const foreign = foreignBlockers(board, entry);
    if (foreign.length) {
      skip(entry, 'FOREIGN_DEPENDENCY');
      reasons.push(`#${entry.item_id} waits on ${foreign.map(ref => `${itemDependencies.dependencyLabel(ref)} (${ref.status} on its own board)`).join(', ')}`);
      continue;
    }
    const continuationSummary = exitContinuationSummary(board, entry.item_id);
    const heldFor = claimWaitingOn(board, entry.item_id);
    if (heldFor.length) { skip(entry, 'WAITING_ON'); reasons.push(`#${entry.item_id} is waiting on ${heldFor.map(id => `#${id}`).join(', ')} to land`); continue; }
    if (!waiting.length && focus && !focus.ids.has(entry.item_id) && otherFocusedWork()) return empty('focus', { item: null, reasons: [`${focus.name} has focused work available in the other mode.`] });
    if (!waiting.length) return { item: continuationSummary ? { ...entry, continuationSummary } : entry, reasons: focusReasons(board, entry,
      [...(rework?.rejection ? [`Rejected #${entry.item_id}: ${rework.rejection.clause ?? ''} — ${rework.rejection.note}; builder handoff ${rework.builder} at ${rework.rejection.commit}`] : []), ...reasons, ...(functionPlan?.warnings ?? [])], { milestones }), shared, crossRunTests: functionPlan?.tests ?? [] };
    skip(entry, 'DEPENDENCY');
    if (idleBlockers && blockers.length < 3) blockers.push({ item: entry.item_id, waitsOn: waiting[0].item_id });
    reasons.push(`#${entry.item_id} waits on ${waiting.map(waitingOn).join(', ')}`);
  }
  // Open work that only overlaps other claims is still claimable (claim warns, never refuses): offer the best one with the overlap noted.
  for (const { entry, shared, collisions, functionPlan, rework, waiting } of overlapping) {
    if (waiting.length || foreignBlockers(board, entry).length || claimWaitingOn(board, entry.item_id).length) continue;
    return { item: entry, reasons: focusReasons(board, entry, [...reasons.filter(line => !collisions.includes(line)), ...collisions.map(line => `overlap: ${line}`), ...(functionPlan?.warnings ?? [])], { milestones }), shared, crossRunTests: functionPlan?.tests ?? [] };
  }
  if (ownRejectionFirst) return { item: held, reasons };
  if (focus && !overflow) return focusIdle();
  if (!mine.length && !reasons.length) reasons.push(idleReason(items, lane, routed));
  // Nothing to claim, yet work above the agent's tier is open: name it and the ways through (B16).
  for (const entry of listItems(board).filter((open) => open.item_status === 'open' && open.item_lane === lane && !open.item_hold_reason && !canTake(route, open.item_route))) {
    reasons.push(`#${entry.item_id} (${entry.item_route}) is open in the ${lane} lane, above your ${route} route: a ${entry.item_route} agent takes it, or, if ${route} can build it, the coordinator reroutes it: pullboard edit ${entry.item_id} --route ${route}`);
  }
  return empty(allItems.some(entry => entry.item_status === 'open' && (lanes ?? [lane]).includes(entry.item_lane) && entry.item_hold_reason) || lanes && selectedLanes.size < lanes.length ? 'held' : 'nothing-eligible', { item: null, reasons });
}

/**
 * The green, unreserved submission this seat may review now, or null [C7, #2992].
 * Finished work waits only on a reviewer, so a seat takes it before any new build with no
 * starvation wait. Only a green gate at the submitted head with no live review reservation
 * counts; every other submission is skipped, and nextFor's reviewer checks, the cross-family rule
 * among them, still decide eligibility.
 *
 * @param {any} board
 * @param {any} who - The nextFor options of the asking seat.
 * @returns {any | null}
 */
export function greenReviewFor(board, who) {
  const skip = new Set(who.skipIds ?? []);
  for (const item of listItems(board)) {
    if (item.item_status !== 'submitted') continue;
    // Only a live reservation holds a review: one that expired or was released leaves the work waiting again.
    if (reviewHolder(board, item) || !greenAtHead(board, item)) skip.add(item.item_id);
  }
  return nextFor(board, { ...who, verify: true, priority: [], skipIds: [...skip] }).item ?? null;
}

/** Infrastructure stops whose candidate waits only on the machine: a spent runner or a gate worker that died (#3325). */
const INFRA_HELD = new Set(['GATE_INFRA_EXHAUSTED', 'SUBMIT_HANDOFF_DEAD']);

/**
 * Whether a gate job belongs to the item's current head: its commit is the item's submitted commit, or it is an
 * infrastructure stop on the frozen bar of an ownerless item that has no commit yet [C7].
 * Why one test: gateAtHead and returnedRecord must agree on which job is current, or a red from an older head shows at claim.
 *
 * @param {any} entry - the item row
 * @param {any} job - the item's submit hand-off record
 * @returns {boolean}
 */
function jobAtHead(entry, job) {
  // An open, ownerless item has no submitted commit, but its frozen criterion still names the work the gate ran: an
  // infrastructure stop on that digest is the same work waiting for the machine, never fresh builder work (#4989).
  const frozenHead = !entry.item_commit && Boolean(entry.item_frozen_digest) && job.digest === entry.item_frozen_digest
    && job.state === 'infrastructure' && job.error?.code === 'GATE_INFRA_EXHAUSTED';
  if (frozenHead) return true;
  if (entry.item_commit) return job.commit === entry.item_commit;
  // A queued gate records the submit only when it is green, so its builder's own red returns a claimed item with no
  // commit: the red is still that claim's, on its frozen bar, and the builder must see it [C7,N2].
  return entry.item_status === 'claimed' && Boolean(entry.item_owner) && job.agentId === entry.item_owner
    && Boolean(entry.item_frozen_digest) && job.digest === entry.item_frozen_digest && job.state === 'red';
}

/**
 * Name the item's newest gate job when it finished with its proof deferred and nothing settled it: its receipt says
 * gate.deferred, not green, and the job has no note:shards.settled step. It carries no hand-off record, so the checks
 * below never see it. Why: such an item showed GATE_WAITING to each new holder, a release reopened it, and next handed
 * it out again; six items were each claimed 4-5 times in two hours (19 Nov) [C7]. A reopen or reject after the job
 * ends the hold. A board with no job tables holds nothing.
 *
 * @param {any} board
 * @param {any} entry
 * @param {string | undefined} returned - the newest reopen or reject event time
 * @returns {string | null}
 */
function deferredGateUnsettled(board, entry, returned) {
  let row;
  try {
    row = board.db.prepare(`SELECT j.job_id AS id, j.job_candidate AS candidate, j.job_step AS step, j.job_updated AS at,
      json_extract(r.job_step_payload, '$.receipt.gate.deferred') AS deferred, json_extract(r.job_step_payload, '$.receipt.gate.green') AS green,
      EXISTS (SELECT 1 FROM job_step s WHERE s.job_step_job = j.job_id AND s.job_step_name = 'note:shards.settled') AS settled
      FROM job j LEFT JOIN job_step r ON r.job_step_id = (SELECT MAX(job_step_id) FROM job_step WHERE job_step_job = j.job_id AND job_step_name = 'receipt')
      WHERE j.job_kind = 'gate' AND j.job_item = ? ORDER BY j.job_created DESC, j.rowid DESC LIMIT 1`).get(entry.item_id);
  } catch { return null; }
  if (!row || row.step !== 'done' || row.deferred !== 1 || row.green === 1 || row.settled) return null;
  if (returned && returned > new Date(row.at).toISOString()) return null;
  return `gate deferred at ${String(row.candidate ?? row.id).slice(0, 12)}, its proof unsettled`;
}

/**
 * Name the gate that already covers an open item's latest head, or null when a build is still due [C7].
 * A queued, running or green gate, or an infrastructure stop under the item's frozen bar, means the work is done and only waits for the
 * machine; a red gate returns the item to its builder, so it stays offered, except a gate red only on main reds,
 * which no build can fix and next never hands out (#3796).
 *
 * Only a job for the item's current head counts: a job left from an older head proves nothing about new work.
 *
 * @param {any} board
 * @param {any} entry
 * @returns {string | null}
 */
export function gateAtHead(board, entry) {
  // A reopen or reject after the job sends the item back for work, so its old gate no longer means "done" (#2955).
  const returned = board.db.prepare("SELECT MAX(event_at) AS at FROM event WHERE item_id = ? AND event_kind IN ('reopen', 'reject')").get(entry.item_id)?.at;
  const deferred = deferredGateUnsettled(board, entry, returned);
  if (deferred) return deferred;
  const job = submitHandoff(board, entry.item_id);
  if (!job || !jobAtHead(entry, job)) return null;
  if (returned && typeof job.at === 'string' && returned > job.at) return null;
  // An infrastructure stop covers the head only under the bar it was built for: a refreeze or edit since asks for a new build.
  const state = job.state === 'infrastructure' ? (INFRA_HELD.has(job.error?.code) && (job.digest ?? null) === (entry.item_frozen_digest ?? null) ? job.error.code : null)
    : job.state === 'red' && job.error?.mainRedOnly === true ? 'red only on main reds'
    : ['queued', 'running', 'green'].includes(job.state) ? job.state : null;
  return state ? `gate ${state} at ${String(job.commit).slice(0, 12)}` : null;
}

/**
 * Whether an open item was built and its gate for the current head went red on its own work, so it holds a builder's
 * commit and no seat holds it [C7, #4014]. A gate red only on main reds is not this item's red, and a reopen or
 * reject after the job sends the item back through its own path.
 *
 * @param {any} board
 * @param {any} entry
 * @returns {boolean}
 */
export function redGateWithoutHolder(board, entry) {
  if (entry.item_status !== 'open' || !entry.item_built_by || !entry.item_commit) return false;
  const job = submitHandoff(board, entry.item_id);
  return Boolean(job && job.commit === entry.item_commit && job.state === 'red' && job.gateGreen !== true && job.error?.mainRedOnly !== true);
}

/**
 * Whether a submitted item's gate went green at its submitted head [C7, #2961].
 * Finished work waits only on a reviewer, so focus never hides it from review: a green submission
 * outside the focused milestone is still offered, while focused reviews keep sorting first.
 *
 * @param {any} board
 * @param {any} entry
 * @returns {boolean}
 */
function greenAtHead(board, entry) {
  const job = submitHandoff(board, entry.item_id);
  return Boolean(job && entry.item_commit && job.commit === entry.item_commit && job.state === 'green');
}

/** The unlanded items a claim released for waiting still waits on (#1225); empty when none. */
function claimWaitingOn(board, id) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < CLAIM_IDLE_ENGINE) return [];
  let waits = [];
  try { waits = JSON.parse(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`claim_waiting:${id}`)?.meta_value ?? '[]'); }
  catch { waits = []; /* Unreadable wait metadata holds nothing; the claim itself re-checks. */ }
  return (Array.isArray(waits) ? waits : []).filter(dependency => {
    const row = board.db.prepare('SELECT item_status,item_merged_commit FROM item WHERE item_id=?').get(dependency);
    return row && row.item_status !== 'withdrawn' && !row.item_merged_commit;
  });
}

/**
 * An item something waits on, as the waiting agent needs it: its state, whether a verifier sent it
 * back, and the lane to shout.
 *
 * @param {any} item
 * @returns {string}
 */
function waitingOn(item) {
  const rejected = item.item_status === 'open' && item.item_verdict === 'REJECT' ? ', rejected' : '';
  return `#${item.item_id} (${item.item_status}${rejected}, ${item.item_lane} lane)`;
}

/**
 * What a returned item hands its next builder: the red gate receipt, the latest reject note and the
 * builder's last facts, or null when the item was never returned red, rejected or refused [C7].
 *
 * @param {any} board
 * @param {number} id
 * @returns {{ gate: any, reject: any, facts: string[] } | null}
 */
export function returnedRecord(board, id) {
  const item = itemById(board, id);
  const job = submitHandoff(board, id);
  const redGate = Boolean(job) && jobAtHead(item, job) && !['queued', 'running', 'green'].includes(job.state) && job.gateGreen !== true && item.item_status !== 'submitted';
  const verdict = item.item_verdict === 'REJECT' ? verdictsFor(board, id).filter(row => row.verdict_decision === 'REJECT').at(-1) : null;
  if (!redGate && !verdict) return null;
  const builder = item.item_built_by ?? item.item_owner;
  const thread = itemThread(board, id), replaced = new Set(thread.map(row => row.supersedes).filter(Boolean));
  const facts = thread.filter(row => row.type === 'fact' && !replaced.has(row.id) && (!builder || row.by === builder)).slice(-3).map(row => `${row.kind}: ${row.text}`);
  return {
    gate: redGate ? { job: job.id, state: job.state, commit: job.commit, code: job.error?.code ?? null, message: job.error?.message ?? null, next: job.error?.next ?? null } : null,
    reject: verdict ? { reason: verdict.verdict_reason, note: verdict.verdict_note, by: verdict.verdict_by, commit: verdict.verdict_commit } : null,
    facts,
  };
}
