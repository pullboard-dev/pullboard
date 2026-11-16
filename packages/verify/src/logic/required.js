import { seatFamily } from '../../../items/light.js';
/** Optional item-specific reviewer families, independent of model names [V1,V2,H16]. */
import { AUTOMATIC_DISPATCH_ENGINE } from '../../../state/light.js';
import { familyName } from './review/policy.js';
import { familyAliasesOf } from './review/policy.js';
import { aliasEngineOn } from './review/policy.js';
import { Refused } from '../../../kernel/light.js';
import { requiredReviewFamily } from './required/engine.js';
export { requiredReviewFamily, requiredReviewFamilyEngine, anyRequiredReviewFamilyEngine } from './required/engine.js';

/** Validate only explicitly supplied metadata; omission preserves legacy move bytes. */
export function validateReviewFamily(value) {
  if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f]/u.test(value))) {
    throw new Refused('BAD_REVIEW_FAMILY', 'name a nonempty reviewer family of at most 100 characters with --review-family <family>');
  }
}

/** Persist inside the caller's item transaction, never inventing a family from a model. */
export function saveReviewFamily(board, id, value) {
  if (value === undefined) return;
  if (value === null) { board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run(`item_review_family:${id}`); return; }
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(`item_review_family:${id}`, value.trim());
}

/** Preserve old item shapes when the optional requirement is absent. */
export function projectReviewFamily(board, item) {
  const family = requiredReviewFamily(board, item.item_id);
  return family === undefined ? item : { ...item, item_review_family: family };
}

/** One shared refusal for selection, reservation and verdicts; old recorded moves retain their meaning. */
export function requiredReviewFamilyProblem(board, item, agentId) {
  if (board.executionEngineVersion !== undefined && board.executionEngineVersion < AUTOMATIC_DISPATCH_ENGINE) return null;
  const required = requiredReviewFamily(board, item.item_id);
  if (!required) return null;
  const declared = seatFamily(board, agentId);
  const aliases = familyAliasesOf(board);
  const same = aliasEngineOn(board) ? familyName(declared, aliases) !== null && familyName(declared, aliases) === familyName(required, aliases)
    : typeof declared === 'string' && declared.trim().toLowerCase() === required.toLowerCase();
  return same ? null
    : new Refused('REQUIRED_REVIEW_FAMILY', `#${item.item_id} requires reviewer family ${required}; join a reviewer with that declared family; model names do not declare a family`);
}
