/** Native review policy and explanations replace prose lineage screening [V4,B26,H16]. */
import { ENGINE_VERSION } from './machine.js';
import { REVIEW_INDEPENDENCE_ENGINE } from './review-independence-engine.js';
import { effectiveAgentParent } from './seats.js';
import { saveReviewFamily } from './required-review-family.js';
import { validateReviewFamily } from './required-review-family.js';
import { Refused } from './refused.js';
import { familyName } from './review-policy.js';
import { itemReviewPolicy } from './review-policy.js';
import { lineSettings } from './line-settings.js';
export { itemReviewPolicy } from './review-policy.js';

/** Old sealed moves keep their recorded authorship and family semantics. */
export function twoTierReviews(board) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_INDEPENDENCE_ENGINE;
}

/** Validate optional policy fields before a move, refusing richer fields under historical engines. */
export function reviewPolicyChange(board, id, { sensitive, reviewFamily } = {}) {
  const present = sensitive !== undefined || reviewFamily !== undefined;
  if (!present) return null;
  if (!twoTierReviews(board)) {
    if (sensitive !== undefined) throw new Refused('ENGINE_VERSION', 'sensitive review policy requires a newer engine');
    validateReviewFamily(reviewFamily);
    return null;
  }
  if (sensitive !== undefined && typeof sensitive !== 'boolean'
    || reviewFamily !== undefined && reviewFamily !== null && (typeof reviewFamily !== 'string'
      || !familyName(reviewFamily) || reviewFamily.length > 80 || /[\x00-\x1f\x7f]/u.test(reviewFamily))) {
    throw new Refused('BAD_REVIEW_POLICY', 'sensitive is a boolean and review-family is a declared family name of at most 80 characters');
  }
  const before = id === null ? { sensitive: false, reviewFamily: null } : itemReviewPolicy(board, id);
  return { version: 1, sensitive: sensitive ?? before.sensitive,
    reviewFamily: reviewFamily === undefined ? before.reviewFamily : reviewFamily === null ? null : reviewFamily.trim() };
}

/** Store policy in the same native transaction and snapshot as its add or edit event. */
export function saveItemReviewPolicy(board, id, policy) {
  if (!policy) return;
  saveReviewFamily(board, id, policy.reviewFamily);
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(`review_independence:${id}`, JSON.stringify(policy));
}

/** Only native submissions binding exact commits establish Standard authorship; a claim or fact does not. */
export function committedItemAuthors(board, item) {
  const authors = new Set(item.item_built_by ? [item.item_built_by] : []);
  for (const event of board.db.prepare("SELECT event_by,event_detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id").all(item.item_id)) {
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(JSON.parse(event.event_detail).commit ?? '')) authors.add(event.event_by);
  }
  return [...authors];
}

/** Review procedure cannot disqualify its own reviewer; ordinary check or build writes still count. */
function reviewProtocol(event) {
  if (['reserve', 'accept', 'reject'].includes(event.event_kind)) return true;
  const detail = JSON.parse(event.event_detail);
  return event.event_kind === 'release' && detail.review === true
    || event.event_kind === 'proof-run' && detail.receipt?.kind === 'verdict';
}

/** Strict adds every other native item write by this persisted session, including helper facts and claims. */
export function strictReviewProblem(board, item, reviewer) {
  if (!twoTierReviews(board) || itemReviewPolicy(board, item.item_id).tier !== 'strict') return null;
  const session = effectiveAgentParent(board, reviewer);
  const touched = board.db.prepare('SELECT event_id,event_by,event_kind,event_detail FROM event WHERE item_id=? ORDER BY event_id').all(item.item_id)
    .find(event => effectiveAgentParent(board, event.event_by) === session && !reviewProtocol(event));
  return touched ? new Refused('STRICT_REVIEW_TOUCHED', `Strict review refuses this session: it wrote ${touched.event_kind} event ${touched.event_id} on #${item.item_id}; ask a session that has not written to this item`) : null;
}

/** Preserve existing known-vendor policy; only the explicit board input adds unknown-family refusal. */
export function reviewFamilyProblem(board, item, reviewer, familyPolicy = 'off') {
  if (!twoTierReviews(board)) return null;
  const policy = itemReviewPolicy(board, item.item_id);
  const declared = board.db.prepare('SELECT agent_family FROM agent WHERE agent_id=?').get(reviewer)?.agent_family;
  const family = familyName(declared);
  const builder = familyName(item.item_builder_family);
  if (lineSettings(board).requireReviewFamilies === true && (!family || !builder)) {
    return new Refused('O2_FAMILY_MATCH', 'this board requires declared vendor families for fresh reviews; declare --family when starting each seat, then resubmit if the submitted builder family was unknown');
  }
  // off/prefer/require keeps its original declared-label comparison, including old optional unknowns.
  if (familyPolicy === 'require' && (!declared || !item.item_builder_family || declared === item.item_builder_family)) {
    return new Refused('O2_FAMILY_MATCH', `#${item.item_id} needs a verifier from another declared family under verify.family require; ask the coordinator to assign one`);
  }
  if (policy.reviewFamily && family !== familyName(policy.reviewFamily)) {
    return new Refused('O2_FAMILY_MATCH', `Strict review requires declared vendor family ${policy.reviewFamily}; ask a reviewer from that family`);
  }
  return null;
}
