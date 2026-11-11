import { REJECT_OPEN_ENGINE } from '../../../state/index.js';
import { lineSettings } from "../../../state/index.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import { REJECTION_RETURN_ENGINE } from "../../../state/index.js";
import { agentHandoff } from "../../../state/index.js";
import { staleInstant } from "./board/stale/state/policy.js";
import { randomUUID } from 'node:crypto';
const ACTIVITY_KINDS = "'claim','renew','submit','accept','reject','release'";

/** Find the latest sealed work event that establishes a seat's activity for rework routing. */
export function nativeRoutingActivity(board, agentId) {
  return board.db.prepare(`SELECT event_id,event_at FROM event WHERE event_by=? AND event_kind IN (${ACTIVITY_KINDS}) ORDER BY event_id DESC LIMIT 1`).get(agentId) ?? null;
}

/** A seat with no work yet uses its native registration time as the retirement-age anchor. */
function nativeSeatAnchor(board, agentId) {
  const activity = nativeRoutingActivity(board, agentId);
  if (activity) return { at: activity.event_at, hasWorkEvent: true };
  const created = board.db.prepare('SELECT agent_created_at FROM agent WHERE agent_id=?').get(agentId)?.agent_created_at ?? null;
  return { at: created, hasWorkEvent: false };
}

/** Read whether a seat is currently responsible for any native claim. */
function hasLiveClaim(board, agentId, now) {
  return Boolean(board.db.prepare("SELECT 1 FROM item WHERE item_owner=? AND item_status='claimed' AND item_lease_until>? LIMIT 1")
    .get(agentId, new Date(now).toISOString()));
}

/** Classify a seat using its sealed work events, claims, and completed native takeover. */
export function nativeSeatRouteState(board, agentId, { takeoverMs, graceMs, now = board.clock.now().getTime() } = {}) {
  if (agentHandoff(board, agentId)?.takenAt) return 'gone';
  if (!Number.isSafeInteger(takeoverMs) || takeoverMs < 0 || !Number.isSafeInteger(graceMs) || graceMs <= 0) return 'unknown';
  const anchor = nativeSeatAnchor(board, agentId);
  const at = staleInstant(anchor.at, now);
  if (at === null) return 'idle';
  const age = now - at;
  if (anchor.hasWorkEvent && age < takeoverMs) return 'live';
  if (age >= graceMs && !hasLiveClaim(board, agentId, now)) return 'gone';
  return 'idle';
}

/** Find the current rejected or reopened episode without relying on display projections. */
function returnedEpisode(board, item) {
  if (item.item_status !== 'open' || !item.item_built_by) return null;
  const event = board.db.prepare("SELECT event_id,event_kind,event_at,event_detail FROM event WHERE item_id=? AND event_kind IN ('submit','reject','reopen') ORDER BY event_id DESC LIMIT 1")
    .get(item.item_id);
  return event && ['reject', 'reopen'].includes(event.event_kind) ? event : null;
}

/** Resolve the permitted builder seats for one returned item; this read is pure and is rechecked by claim. */
export function reworkFamilyRoute(board, item, { listAgents, routeOf, canTake, seatFamily, canonicalFamily, policy, now = board.clock.now().getTime() } = {}) {
  const episode = returnedEpisode(board, item);
  if (!episode) return { applies: false, allowed: null };
  const openRejections = (board.executionEngineVersion ?? ENGINE_VERSION) >= REJECT_OPEN_ENGINE;
  if ((openRejections || rejectionReturnEnabled(board)) && episode.event_kind === 'reject') {
    const builder = item.item_built_by;
    const detail = JSON.parse(episode.event_detail);
    const reservation = detail.reopenFirstRefusal;
    const reservedForBuilder = !openRejections && reservation?.builder === builder && now < Date.parse(reservation.until); // #2779: a window an older engine sealed lapses on upgrade
    const beforeDeadline = reservedForBuilder || (!openRejections && now < Date.parse(episode.event_at) + 30 * 60_000);
    const verdict = board.db.prepare("SELECT verdict_note FROM verdict WHERE item_id=? ORDER BY verdict_id DESC LIMIT 1").get(item.item_id);
    return { applies: true, mode: beforeDeadline ? 'builder' : 'rejected-open', builder, episode: episode.event_id,
      allowed: beforeDeadline ? [builder] : null, rejection: { clause: detail.clause, note: verdict?.verdict_note ?? '', commit: item.item_commit } };
  }
  if (rejectionReturnEnabled(board) && !lineSettings(board).reworkSameFamily) return { applies: false, allowed: null };
  if (!policy || !Number.isSafeInteger(policy.takeoverMs) || !Number.isSafeInteger(policy.graceMs)) {
    return { applies: true, mode: 'policy-unknown', allowed: [] };
  }
  const builder = item.item_built_by;
  const builderState = nativeSeatRouteState(board, builder, { ...policy, now });
  const builderFamily = canonicalFamily(board, item.item_builder_family);
  if (builderState !== 'gone') {
    return { applies: true, mode: 'builder', builder, builderFamily, episode: episode.event_id, allowed: [builder] };
  }
  if (!builderFamily) return { applies: true, mode: 'ordinary', builder, builderFamily: null, episode: episode.event_id, allowed: null };

  const sameFamily = listAgents(board).filter(seat => seat.agent_lane === item.item_lane
    && canonicalFamily(board, seatFamily(board, seat.agent_id)) === builderFamily
    && canTake(routeOf(board, seat.agent_id), item.item_route));
  const live = sameFamily.filter(seat => nativeSeatRouteState(board, seat.agent_id, { ...policy, now }) === 'live').map(seat => seat.agent_id).sort();
  if (live.length) return { applies: true, mode: 'family', builder, builderFamily, episode: episode.event_id, allowed: live };
  const checkedFamilies = [...new Set(listAgents(board).filter(seat => seat.agent_lane === item.item_lane)
    .map(seat => canonicalFamily(board, seatFamily(board, seat.agent_id))).filter(Boolean))].sort();
  return { applies: true, mode: 'fallback', builder, builderFamily, episode: episode.event_id, allowed: null, checkedFamilies };
}

/** Seal one captured policy and portable fallback identity before the claim enters the native writer. */
export function sealReworkRoutingPolicy(windows) {
  return windows ? { ...windows, factId: randomUUID() } : null;
}

/** Tell whether the item is a return episode for engine sealing before the claim is prepared. */
export function isReturnedRework(board, id) {
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
  return Boolean(item && returnedEpisode(board, item));
}

/** Keep new boards and historical replay on the prior rework policy until explicitly enabled [B35,H16]. */
export function rejectionReturnEnabled(board) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= REJECTION_RETURN_ENGINE && lineSettings(board).returnRejectedWork === true;
}
