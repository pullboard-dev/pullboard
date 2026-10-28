/** Shared review urgency and tier adapter for selection and reservation [C7,V1,B3]. */
import { ENGINE_VERSION } from './engine-metadata.js';
import { REVIEW_ROUTING_ENGINE } from './review-routing-engine.js';
import { familyName, itemReviewPolicy } from './review-policy.js';
import { Refused } from './refused.js';

/** Historical recorded reservations retain the ordering and eligibility they originally used. */
export function reviewRoutingEnabled(board) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_ROUTING_ENGINE;
}

/** Read the canonical native tier; sensitive work is strict even without a required reviewer family. */
function strictReview(board, item) {
  return itemReviewPolicy(board, item.item_id).tier === 'strict';
}

/** Strict routing additionally needs a declared different vendor, even when the board family policy is off. */
export function strictReviewProblem(board, item, agentId) {
  if (!reviewRoutingEnabled(board) || !strictReview(board, item)) return null;
  const family = familyName(board.db.prepare('SELECT agent_family FROM agent WHERE agent_id=?').get(agentId)?.agent_family, board.familyAliases);
  const built = familyName(item.item_builder_family, board.familyAliases);
  return family && built && family !== built ? null
    : new Refused('O2_FAMILY_MATCH', `#${item.item_id} is strict; ask a verifier from another declared vendor family`);
}

/** Use the current submission event; facts, reservations and previous submissions cannot reset its age. */
function reviewSubmission(board, item) {
  const submit = board.db.prepare("SELECT event_id,event_at FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1")
    .get(item.item_id);
  if (!submit) return null;
  const reviewed = board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_id>? AND event_kind='reserve' LIMIT 1")
    .get(item.item_id, submit.event_id);
  const at = Date.parse(submit.event_at);
  return Number.isFinite(at) ? { at, firstReviewer: !reviewed, order: submit.event_id } : null;
}

/** A free seat takes a normal submission awaiting its first reviewer for more than ten minutes. */
export function overdueReview(board, item) {
  if (item.item_status !== 'submitted' || !reviewRoutingEnabled(board) || strictReview(board, item)) return false;
  const submission = reviewSubmission(board, item);
  return Boolean(submission?.firstReviewer && board.clock.now().getTime() - submission.at > 10 * 60_000);
}

/** Order eligible reviews by current submission age, with deterministic native event and item ties. */
function oldestReviewOrder(board, items) {
  const submitted = new Map(items.map(item => [item.item_id, reviewSubmission(board, item)]));
  return (first, second) => (submitted.get(first.item_id)?.at ?? Infinity) - (submitted.get(second.item_id)?.at ?? Infinity)
    || (submitted.get(first.item_id)?.order ?? Infinity) - (submitted.get(second.item_id)?.order ?? Infinity)
    || first.item_id - second.item_id;
}


/** Apply focus ordering historically, then modern main-red urgency and submission age. */
export function prioritizeReviews(board, candidates, priority, focusCompare) {
  candidates.sort((a, b) => focusCompare(a.entry, b.entry));
  if (!reviewRoutingEnabled(board)) return;
  const oldest = oldestReviewOrder(board, candidates.map(candidate => candidate.entry));
  const mainRed = new Set(priority);
  candidates.sort((a, b) => Number(mainRed.has(b.entry.item_id)) - Number(mainRed.has(a.entry.item_id)) || oldest(a.entry, b.entry));
}
