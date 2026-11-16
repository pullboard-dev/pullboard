/** Derive authority from existing seats and claims; no mutable saved grant supplies permission [E21]. */
import { engineNumber } from './engine/number.js';
import { Refused } from '../../../kernel/light.js';
import { recordedGrantActivation } from '../../index.js';
import { completesAdmittedSubmit } from '../../index.js';
const AGENT_GRANT_ENGINE = engineNumber('AGENT_GRANT_ENGINE');
const REVIEW_GRANT_ENGINE = engineNumber('REVIEW_GRANT_ENGINE');
const BAR_SIGN_GRANT_ENGINE = engineNumber('BAR_SIGN_GRANT_ENGINE');
const QUEUED_START_GRANT_ENGINE = engineNumber('QUEUED_START_GRANT_ENGINE');

// Attributed append-only findings never confer authority over item state.
const ADMINISTRATIVE = new Set(['shout', 'claim', 'release', 'reserveReview', 'appendFact', 'recordAttempt', 'completeSubmitHandoff']);

/** Bind only item mutations declared by the public operation, including item creation. */
function target(move, registry) {
  if (move.operation === 'addItem') return { lane: move.args?.[0]?.lane, creating: true };
  if (move.operation === 'applyRehomeItem') return { item: move.args?.[0]?.destinationItemId,
    lane: move.args?.[0]?.item?.item_lane, creating: true };
  if (registry[move.operation]?.itemIdFirstArgument) return { item: move.args?.[0] };
  return null;
}

/**
 * The item's newest hand-off record from its gate jobs' steps, as the drive and jobs cells record it (#3476).
 * Why here: the grant check runs inside the state cell, which reads the job tables but never writes them.
 */
function queuedGateRecord(db, itemId) {
  const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('job','job_step')").get().n;
  if (tables < 2) return null;
  const row = db.prepare(`SELECT s.job_step_payload AS payload FROM job j JOIN job_step s ON s.job_step_job = j.job_id
    WHERE j.job_kind = 'gate' AND j.job_item = ? AND json_extract(s.job_step_payload, '$.record') IS NOT NULL
    ORDER BY s.job_step_id DESC LIMIT 1`).get(itemId);
  try { return row ? JSON.parse(row.payload).record : null; } catch { return null; }
}

/**
 * Whether this move starts the queued gate job this seat queued for the item it still holds. Why: a gate can wait in the
 * handoff queue longer than the claim's lease; the job was admitted under the live claim, so its start is not a new item
 * change, and refusing it AGENT_GRANT_EXPIRED left the gate never run and returned red (#3129). Another seat's claim
 * since then makes the item no longer this seat's, so the start is still refused.
 */
function startsQueuedSubmit(board, move, item, actor) {
  if (move.engine < QUEUED_START_GRANT_ENGINE || move.operation !== 'startSubmitHandoff' || move.args?.[1]?.hookProjection
    || item?.item_status !== 'claimed' || item.item_owner !== actor) return false;
  const job = queuedGateRecord(board.db, item.item_id);
  return job?.state === 'queued' && job.agentId === actor && job.id === move.args?.[1]?.job;
}

/** Resolve existing accepted ids with the mutation's SQLite affinity; defer malformed/missing ids. */
function existingItem(board, id) {
  if (!Number.isSafeInteger(id) && typeof id !== 'string') return null;
  return board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id) ?? null;
}

/** A version marker is not a grant: it only prevents an older engine bypassing a new seat or claim. */
export function agentGrantMinimum(board, move, { registry } = board.enginePorts) {
  // Communication and review administration neither widen nor replace a claim. An old claim could erase its version marker.
  if (move.operation !== 'claim' && (ADMINISTRATIVE.has(move.operation) || !target(move, registry))) return 1;
  const actor = registry[move.operation]?.actor(move);
  // Person, coordinator and machine moves are never grant-checked, so activation cannot wedge an in-flight one.
  if (typeof actor !== 'string' || ['person', 'coordinator', 'machine'].includes(actor)) return 1;
  // The newest engine never grant-checks a verdict, so an older verdict bypasses nothing and replays under its own rules.
  if (move.operation === 'verify') return 1;
  if (recordedGrantActivation(board)) return AGENT_GRANT_ENGINE;
  const event = board.db.prepare("SELECT event_detail FROM event WHERE event_by=? AND event_kind IN ('join','claim','renew') ORDER BY event_id DESC LIMIT 1").get(actor);
  const item = existingItem(board, target(move, registry)?.item ?? (move.operation === 'claim' ? move.args?.[0] : null));
  const claimed = item ? board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind IN ('claim','renew') ORDER BY event_id DESC LIMIT 1").get(item.item_id) : null;
  return [event, claimed].some(row => {
    const version = row && JSON.parse(row.event_detail).grantEngine;
    return Number.isSafeInteger(version) && version >= AGENT_GRANT_ENGINE;
  }) ? AGENT_GRANT_ENGINE : 1;
}

/** Refuse out-of-grant item changes at the same ordered instant on every replica. */
export function requireAgentGrant(board, move, at = board.clock.now(), { registry } = board.enginePorts) {
  if (move.engine < AGENT_GRANT_ENGINE || ADMINISTRATIVE.has(move.operation)) return;
  // Reopen owns coordinator/reviewer authority; agentGrantMinimum retains the marked-seat/target floor.
  if (move.operation === 'reopen') return;
  const actor = registry[move.operation]?.actor(move);
  if (typeof actor !== 'string' || ['person', 'coordinator', 'machine'].includes(actor)) return;
  const seat = board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id=?').get(actor);
  if (!seat) return; // Existing operation validation owns unknown-seat refusals.
  const scope = target(move, registry);
  if (!scope) return;
  const item = existingItem(board, scope.item);
  if (!scope.creating && !item) return; // Preserve the operation's own malformed/missing-item refusal.
  const now = at.toISOString();
  // A verdict is review, not an item change: verify's own rules (reservations, builder and session
  // independence) govern reviewers, who check other lanes' work by design. Older verdicts keep the
  // reservation-only rule they were recorded under, so every replica replays them identically.
  if (move.operation === 'verify' && move.engine >= REVIEW_GRANT_ENGINE) return;
  // A bar signature is the outside review a bar needs before anyone claims it, so it crosses lanes by design.
  if (move.operation === 'signBar' && move.engine >= BAR_SIGN_GRANT_ENGINE) return;
  // A companion objection is the owning lane's review of another lane's patch: the objector holds no claim on the item [C7].
  if (move.operation === 'objectItemPatch') return;
  if (item?.item_review_by === actor && item.item_status === 'submitted' && item.item_review_until > now
    && move.operation === 'verify') return;
  const held = board.db.prepare("SELECT item_id,item_lease_until FROM item WHERE item_owner=? AND item_status='claimed'").all(actor);
  // itemsInGate sealed in the move: up to that many gate-waiting claims are not the building claim [C7,#8420].
  const waiting = held.filter(c => c.item_id !== item?.item_id && ['queued', 'running', 'green'].includes(queuedGateRecord(board.db, c.item_id)?.state)).slice(0, move.itemsInGate > 0 ? move.itemsInGate : 0);
  const claims = held.filter(claim => !waiting.includes(claim));
  const own = claims.find(claim => claim.item_id === item?.item_id);
  const live = claims.filter(claim => claim.item_lease_until > now);
  const liveHeld = held.filter(claim => claim.item_lease_until > now);
  const previous = board.db.prepare("SELECT event_id FROM event WHERE event_by=? AND event_kind IN ('claim','renew') ORDER BY event_id DESC LIMIT 1").get(actor);
  if (((own && !(own.item_lease_until > now)) || (previous && !liveHeld.length))
    && !completesAdmittedSubmit(board, move, item, actor) && !startsQueuedSubmit(board, move, item, actor)) {
    throw new Refused('AGENT_GRANT_EXPIRED', `${actor} has no live item claim; claim work before changing an item`,
      'claim the intended item, or shout the coordinator if its claim is unavailable');
  }
  // The split step: a lane seat files the coordinator piece of a cross-ownership item --after its own live claimed
  // item, and nothing else into the coordinator lane; every other add there still refuses AGENT_GRANT_LANE [C7,#3278].
  if (move.operation === 'addItem' && scope.lane === 'coordinator'
    && live.some(claim => [].concat(move.args?.[0]?.after ?? []).map(String).includes(String(claim.item_id)))) return;
  if ((claims.length && !own) || (live.length && scope.creating)) {
    throw new Refused('AGENT_GRANT_ITEM', `${actor} may change only its live claimed item${live.length === 1 ? ` #${live[0].item_id}` : 's'}`,
      'finish or release the claim, then claim the intended item; use shout for coordination');
  }
  const lane = scope.creating ? scope.lane : item.item_lane;
  if (lane !== seat.agent_lane) {
    throw new Refused('AGENT_GRANT_LANE', `${actor} is in ${seat.agent_lane}, not ${lane}`,
      'join a seat in the intended lane or ask its owner to make the item change');
  }
}
