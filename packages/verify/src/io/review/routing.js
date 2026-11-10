import { REVIEW_HEAD_BUILDER_FAMILY_ENGINE } from '../../../../state/light.js';
import { VENDOR_FAMILY_ENGINE } from '../../../../state/light.js';
import { reviewPatchAuthors } from './composition.js';
import { compositionFamilyFallback } from './composition.js';
import { seatFamily } from '../../../../items/index.js';
import { FAMILY_DECLARE_ENGINE } from '../../../../state/light.js';
/** Board moves read a seat's one derived family through the review routing they already use (#1783). */
export { seatFamily };
/** Shared review urgency and tier adapter for selection and reservation [C7,V1,B3]. */
import { ENGINE_VERSION } from '../../../../state/index.js';
import { FAMILY_ALIAS_ENGINE } from '../../../../state/light.js';
import { REVIEW_INDEPENDENCE_ENGINE } from '../../../../state/light.js';
import { familyName } from '../../logic/review/policy.js';
import { sameFamilyProblem } from '../../logic/review/policy.js';
import { familyAliasesOf } from '../../logic/review/policy.js';

export { familiesDiffer } from '../../logic/review/policy.js';
import { itemReviewPolicy } from '../../logic/review/policy.js';
import { Refused } from '../../../../kernel/index.js';
import { reviewRoutingEnabled } from '../../../../seats/index.js';
export { reviewRoutingEnabled } from '../../../../seats/index.js';


/** Read the canonical native tier; sensitive work is strict even without a required reviewer family. */
function strictReview(board, item) {
  return itemReviewPolicy(board, item.item_id).tier === 'strict';
}

/** Strict routing additionally needs a declared different vendor, even when the board family policy is off. */
export function strictReviewProblem(board, item, agentId) {
  if (!reviewRoutingEnabled(board) || !strictReview(board, item)) return null;
  const family = familyName(seatFamily(board, agentId), familyAliasesOf(board));
  const fallback = compositionFamilyFallback(board, item);
  const built = fallback?.family ?? familyName(builderFamilyOf(board, item), familyAliasesOf(board));
  const join = (!family || !built) && (board.executionEngineVersion ?? ENGINE_VERSION) >= VENDOR_FAMILY_ENGINE ? 'pullboard join --family <vendor>' : undefined;
  if (!(family && built && family !== built)) {
    const message = `#${item.item_id} is strict; ask a verifier from another declared vendor family${join ? `; declare missing families with ${join}` : ''}`;
    return family && built && family === built ? sameFamilyProblem(board, message) : new Refused('O2_FAMILY_MATCH', message, join);
  }
  return fallback ? null : companionFamilyProblem(board, item, family);
}

/** Use the current submission event; facts, reservations and previous submissions cannot reset its age. */
function reviewSubmission(board, item) {
  const submit = board.db.prepare("SELECT event_id,event_at FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1")
    .get(item.item_id);
  if (!submit) return null;
  const at = Date.parse(submit.event_at);
  return Number.isFinite(at) ? { at, order: submit.event_id } : null;
}

/** Observe the current submission's unreserved wait, including strict work and expired reservations. */
export function reviewWait(board, item, reads = board.nativePorts) {
  if (item.item_status !== 'submitted' || !reviewRoutingEnabled(board) || reads.reviewHolder(board, item)) return null;
  const submission = reviewSubmission(board, item);
  return submission ? { since: new Date(submission.at).toISOString(), ageMs: board.clock.now().getTime() - submission.at } : null;
}

/** A free eligible seat interrupts new work after the configured wait; reservation guards still decide eligibility. */
export function overdueReview(board, item, starveMinutes = 5, reads = board.nativePorts) {
  const wait = reviewWait(board, item, reads);
  return Boolean(wait && wait.ageMs > starveMinutes * 60_000);
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
  // Only the submitted head builder's family is judged; earlier or companion authors of other families do not exclude [V1].
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_HEAD_BUILDER_FAMILY_ENGINE) return null;
  const aliases = familyAliasesOf(board);
  for (const author of reviewPatchAuthors(board, item)) {
    const declared = seatFamily(board, author.agentId);
    if (familyName(declared, aliases) === family) {
      return sameFamilyProblem(board, `#${item.item_id} is strict and companion author ${author.agentId} shares your vendor family; ask a verifier from another declared vendor family`);
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

/**
 * The family a submission's builder counts as: the family recorded at submit, or, when none was recorded, the builder
 * seat's current derived family. Why: a seat that joined without --family submits a null family, which refused every
 * reviewer with O2_FAMILY_MATCH although the seat's session has since declared one (#2889). Replays under an engine
 * older than the declaration engine keep the recorded value.
 */
export function builderFamilyOf(board, item) {
  const recorded = item.item_builder_family;
  if (typeof recorded === 'string' && recorded.trim() !== '') return recorded;
  if ((board.executionEngineVersion ?? Infinity) < FAMILY_DECLARE_ENGINE || !item.item_built_by) return recorded ?? null;
  return seatFamily(board, item.item_built_by) ?? recorded ?? null;
}
