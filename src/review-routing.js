import { seatFamily } from './family-declaration.js';
/** Board moves read a seat's one derived family through the review routing they already use (#1783). */
export { seatFamily };
/** Shared review urgency and tier adapter for selection and reservation [C7,V1,B3]. */
import { ENGINE_VERSION } from './engine-metadata.js';
import { REVIEW_ROUTING_ENGINE } from './review-routing-engine.js';
import { FAMILY_ALIAS_ENGINE } from './family-alias-engine.js';
import { REVIEW_INDEPENDENCE_ENGINE } from './review-independence-engine.js';
import { familyName } from './review-policy.js';
import { familyAliasesOf } from './review-policy.js';

export { familiesDiffer } from './review-policy.js';
import { itemReviewPolicy } from './review-policy.js';
import { itemPatchAuthors } from './item-patch-state.js';
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
  const family = familyName(seatFamily(board, agentId), familyAliasesOf(board));
  const built = familyName(item.item_builder_family, familyAliasesOf(board));
  if (!(family && built && family !== built)) return new Refused('O2_FAMILY_MATCH', `#${item.item_id} is strict; ask a verifier from another declared vendor family`);
  return companionFamilyProblem(board, item, family);
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

/** From the alias engine on, a reviewer may not share a vendor family with any companion patch author of a strict item [#1762]. */
function companionFamilyProblem(board, item, family) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < FAMILY_ALIAS_ENGINE) return null;
  const aliases = familyAliasesOf(board);
  for (const author of itemPatchAuthors(board, item.item_id)) {
    const declared = seatFamily(board, author.agentId);
    if (familyName(declared, aliases) === family) {
      return new Refused('O2_FAMILY_MATCH', `#${item.item_id} is strict and companion author ${author.agentId} shares your vendor family; ask a verifier from another declared vendor family`);
    }
  }
  return null;
}

/** One declared spelling mapped to its canonical vendor family under the alias engine's rules [#1762]. */
export function canonicalFamily(board, value) {
  return familyName(value, familyAliasesOf(board));
}

/** From the alias engine on, a strict item's builder must have declared a vendor family; the fix is to join with one [#1762]. */
export function requireStrictBuilderFamily(board, id, agentId) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (engine < FAMILY_ALIAS_ENGINE || engine < REVIEW_INDEPENDENCE_ENGINE || board.db.prepare('SELECT item_owner FROM item WHERE item_id=?').get(id)?.item_owner !== agentId
    || !strictReview(board, { item_id: id })) return;
  const declared = seatFamily(board, agentId);
  if (!canonicalFamily(board, declared)) throw new Refused('UNDECLARED_BUILDER_FAMILY', `#${id} is strict and ${agentId} declared no vendor family; rejoin with: pullboard join <lane> --family <vendor>, then resubmit`);
}

/** Preserve the native release cooldown and its historical floor through explicit board readers [V1,R1]. */
export function reviewReleaseCooldown(board, itemId, agentId, { engineVersion, reviewReleasesSinceSubmit, cooldownMs }) {
  if ((board.executionEngineVersion ?? engineVersion) < 5) return null;
  const event = reviewReleasesSinceSubmit(board, itemId, agentId).find((release) => !release.legacy);
  if (!event) return null;
  const until = Date.parse(event.event_at) + cooldownMs;
  return until > board.clock.now().getTime() ? new Date(until).toISOString() : null;
}
