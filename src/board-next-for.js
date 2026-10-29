import { committedItemAuthors } from './review-independence.js';
import { strictReviewProblem } from './review-independence.js';
import { firstRefusal } from './board-item-read.js';
import * as reviewRouting from './review-routing.js';
import { reviewFamilyProblem } from './review-independence.js';
import { twoTierReviews } from './review-independence.js';
import { idleReason } from './routing-presence.js';
import { liveRouteProblem } from './routing-presence.js';
import * as itemDependencies from './item-dependencies.js';
import * as reviewFamilies from './required-review-family.js';
import { criticalPathEnabled } from './critical-path-order.js';
import { criticalPathOrder } from './critical-path-order.js';
import { focusOrder } from './focus-milestone.js';
import { focusReasons } from './focus-milestone.js';
import { milestoneFocus } from './focus-milestone.js';
import { milestones } from './board-read-auxiliary.js';
import { milestonePriorities } from './board-read-auxiliary.js';
import { lineOrderEnabled } from './line-order.js';
import { reviewerScarcity } from './line-order.js';
import { current } from './board-query.js';
import { itemById } from './board-query.js';
import { listItems } from './board-query.js';
import { reviewHolder } from './board-query.js';
import { itemHold } from './board-query.js';
import { laneHold } from './board-query.js';
import { itemFiles } from './item-files.js';
import { itemFileCollisions } from './item-files.js';
import { COORDINATOR } from './config.js';
import { firstRefusalReason } from './claims.js';
import { ENGINE_VERSION } from './machine.js';
import { MILESTONE_RANK_ENGINE } from './machine.js';
import { itemAuthorProblem } from './item-authors.js';
import { ROUTES } from './route-escalation.js';
import { canTake } from './route-escalation.js';
import { routeOf } from './seats.js';
import { milestoneRanks } from './work-order.js';
import { foreignBlockers } from './board.js';
import { reviewReleaseCooldown } from './board.js';
import { reviewerChecks } from './board.js';
import { buildOrder } from './board-build-order.js';

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
 * @param {{ agentId: string, lane: string, verify?: boolean, policy?: string, familyPolicy?: string, runnable?: boolean, routes?: string[], warm?: string[], priority?: number[], lanes?: string[], skipIds?: number[], omitIds?: number[], afterRelease?: number }} who
 * @returns {{ item: any | null, reasons: string[], shared?: string[] }}
 */
export function nextFor(board, { agentId, lane, verify = false, policy = 'any', familyPolicy = 'off', runnable = false, routes = ROUTES, warm = [], priority = [], lanes, skipIds = [], omitIds = [], afterRelease, observeIdle = false }) {
  /** Optional diagnostic data leaves historical query result shapes and all selection guards unchanged. */
  const empty = (reason, result) => observeIdle ? { ...result, idleReason: reason } : result;
  const focusCompare = focusOrder(board, () => 0, { milestones });
  const route = routeOf(board, agentId);
  const tier = (entry) => ROUTES.indexOf(entry.item_route);
  const allItems = listItems(board).reverse();
  const items = allItems
    .filter((entry) => !omitIds.includes(entry.item_id) && canTake(route, entry.item_route) && routes.includes(entry.item_route) && (!runnable || entry.item_check))
    .sort((first, second) => tier(second) - tier(first));
  const tiers = route === 'strong' ? '' : `${ROUTES.slice(0, ROUTES.indexOf(route) + 1).reverse().join(' or ')} `;
  const routed = `${tiers}${runnable ? 'runnable ' : ''}`;
  if (verify) {
    const family = reviewRouting.seatFamily(board, agentId);
    const hasDifferentFamily = (entry) => reviewRouting.familiesDiffer(board, family, entry.item_builder_family);
    const unrelated = items.filter((entry) => entry.item_status === 'submitted' && entry.item_built_by !== agentId && !skipIds.includes(entry.item_id));
    const standingRefusal = unrelated.map((entry) => itemAuthorProblem(board, entry, agentId, { committedItemAuthors, twoTierReviews, strictReviewProblem }) ?? reviewFamilyProblem(board, entry, agentId, familyPolicy)).find(Boolean);
    const requiredRefusals = unrelated.map(entry => reviewFamilies.requiredReviewFamilyProblem(board, entry, agentId)).filter(Boolean);
    let reviewable = unrelated.filter((entry) => !itemAuthorProblem(board, entry, agentId, { committedItemAuthors, twoTierReviews, strictReviewProblem }) && !reviewFamilyProblem(board, entry, agentId, familyPolicy) && !reviewFamilies.requiredReviewFamilyProblem(board, entry, agentId) && !reviewRouting.strictReviewProblem(board, entry, agentId));
    if (policy === COORDINATOR && agentId !== COORDINATOR) reviewable = reviewable.filter((entry) => entry.item_lane === COORDINATOR);
    if (familyPolicy === 'require') reviewable = reviewable.filter(hasDifferentFamily);
    if (familyPolicy === 'prefer') reviewable.sort((first, second) => Number(hasDifferentFamily(second)) - Number(hasDifferentFamily(first)));
    const candidates = reviewable.map((entry) => ({
      entry,
      holder: reviewHolder(board, entry),
      cooldown: reviewReleaseCooldown(board, entry.item_id, agentId),
    }));
    const heldByMe = candidates.find((candidate) => candidate.holder === agentId)?.entry;
    if (heldByMe) return { item: heldByMe, reasons: [] };
    const presenceProblem = liveRouteProblem(board, agentId);
    if (presenceProblem) return empty('unknown', { item: null, reasons: [presenceProblem] });
    const milestonePriority = milestonePriorities(board);
    const rank = milestoneRanks(board, milestonePriority, { milestones });
    const scarcity = lineOrderEnabled(board) ? reviewerScarcity(board, candidates.map(candidate => candidate.entry), (entry, reviewer) =>
      Object.values(reviewerChecks(board, { agentId: reviewer, policy, familyPolicy })).every(guard => !guard(entry))) : null;
    const lineCompare = scarcity ? buildOrder(board, { agentId }) : null;
    const previousOrder = (first, second) => scarcity ? scarcity.get(first.item_id) - scarcity.get(second.item_id)
      || lineCompare(first, second) : milestonePriority(first) - milestonePriority(second)
      || rank(first) - rank(second);
    const focus = milestoneFocus(board, { milestones });
    const group = item => focus?.ids.has(item.item_id) ? -1 : milestonePriority(item);
    const order = criticalPathEnabled(board) ? criticalPathOrder({ items: listItems(board, { all: true }), group, fallback: previousOrder }) : previousOrder;
    candidates.sort((first, second) => order(first.entry, second.entry));
    reviewRouting.prioritizeReviews(board, candidates, priority, focusCompare);
    const item = candidates.find((candidate) => !candidate.holder && !candidate.cooldown)?.entry;
    if (item) return { item, reasons: focusReasons(board, item, [], { milestones }) };
    const held = candidates.filter((candidate) => candidate.holder && candidate.holder !== agentId)
      .map(({ entry, holder: reviewer }) => `${reviewer} holds the review of #${entry.item_id} until ${entry.item_review_until}`);
    const cooling = candidates.filter((candidate) => candidate.cooldown)
      .map(({ entry, cooldown }) => `you released the review of #${entry.item_id}; try again after ${cooldown}, or let another reviewer take it`);
    return empty(held.length || cooling.length ? 'held' : requiredRefusals.length || standingRefusal?.code?.includes('FAMILY') ? 'review-family' : standingRefusal ? 'unknown' : 'nothing-eligible', { item: null, reasons: [`nothing ${routed}submitted that you did not build${held.length ? ' and no other agent is reviewing' : ''}`,
      ...(standingRefusal ? [standingRefusal.message] : []), ...requiredRefusals.map(error => error.message), ...held, ...cooling] });
  }
  const held = items.find((entry) => entry.item_status === 'claimed' && entry.item_owner === agentId && entry.item_parent_id === null);
  // Read-only build planning may disregard exactly this caller's claim; the ordered claim transition still enforces ONE_CLAIM.
  const plannedRelease = held && held.item_id === afterRelease ? held.item_id : null;
  if (held && plannedRelease === null) return { item: held, reasons: [] };
  const presenceProblem = liveRouteProblem(board, agentId);
  if (presenceProblem) return empty('unknown', { item: null, reasons: [presenceProblem] });
  const selectedLanes = new Set(lanes ?? [lane]);
  const reasons = allItems.filter((entry) => entry.item_status === 'open' && selectedLanes.has(entry.item_lane) && entry.item_hold_reason)
    .map((entry) => `#${entry.item_id} is held by coordinator: ${entry.item_hold_reason}`);
  const paused = laneHold(board, lane);
  if (!lanes && paused) return empty('held', { item: null, reasons: [`${paused.hold_by} holds the ${lane} lane: ${paused.hold_reason}`, ...reasons] });
  if (lanes) for (const name of selectedLanes) {
    const hold = laneHold(board, name);
    if (hold) { selectedLanes.delete(name); reasons.push(`${hold.hold_by} holds the ${name} lane: ${hold.hold_reason}`); }
  }
  const compare = buildOrder(board, { warm, agentId, tierFirst: true });
  const inFlight = listItems(board, { all: true }).filter(entry => entry.item_id !== plannedRelease);
  const recent = new Set(warm);
  const mainRed = new Set(priority);
  const laneItems = items.filter((entry) => entry.item_status === 'open' && selectedLanes.has(entry.item_lane));
  const mine = laneItems
    .filter((entry) => !itemHold(board, entry.item_id))
    .map((entry, order) => ({ entry, order, shared: itemFiles(entry).filter((path) => recent.has(path)) }))
    .sort((first, second) => compare(first.entry, second.entry));
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
  for (const { entry, shared } of mine) {
    const waiting = itemDependencies.localDependencyIds(entry)
      .map((id) => current(board, itemById(board, id)))
      .filter((before) => before.item_status !== 'verified');
    const reserved = firstRefusalReason(board, entry.item_id, agentId, { firstRefusal });
    if (reserved) { reasons.push(reserved); continue; }
    const collisions = itemFileCollisions(entry, inFlight);
    if (collisions.length) { reasons.push(...collisions); continue; }
    const foreign = foreignBlockers(board, entry);
    if (foreign.length) {
      reasons.push(`#${entry.item_id} waits on ${foreign.map(ref => `${itemDependencies.dependencyLabel(ref)} (${ref.status} on its own board)`).join(', ')}`);
      continue;
    }
    if (!waiting.length) return { item: entry, reasons: focusReasons(board, entry,
      [...reasons, ...collisions.map(reason => reason.replace(' waits for ', ' overlaps with '))], { milestones }), shared };
    reasons.push(`#${entry.item_id} waits on ${waiting.map(waitingOn).join(', ')}`);
  }
  if (!mine.length && !reasons.length) reasons.push(idleReason(items, lane, routed));
  // Nothing to claim, yet work above the agent's tier is open: name it and the ways through (B16).
  for (const entry of listItems(board).filter((open) => open.item_status === 'open' && open.item_lane === lane && !open.item_hold_reason && !canTake(route, open.item_route))) {
    reasons.push(`#${entry.item_id} (${entry.item_route}) is open in the ${lane} lane, above your ${route} route: a ${entry.item_route} agent takes it, or, if ${route} can build it, the coordinator reroutes it: pullboard edit ${entry.item_id} --route ${route}`);
  }
  return empty(allItems.some(entry => entry.item_status === 'open' && (lanes ?? [lane]).includes(entry.item_lane) && entry.item_hold_reason) || lanes && selectedLanes.size < lanes.length ? 'held' : 'nothing-eligible', { item: null, reasons });
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
