/** Writer-only carry preparation stays outside the read-side verdict import graph [C7,V4,H16]. */
import { deriveMergeOnly } from './source.js';
import {
  mergeOnlyBasis,
  mergeOnlySourceValid,
} from './verdict.js';
import { retainedVerifierIdentityProblem } from '../../../../items/index.js';
import { itemPatchDigest } from '../../../../items/index.js';

/** Derive the origin’s carry before sealing; caller-supplied carry facts are discarded. */
export function prepareMergeOnlySubmit(board, id, options, reads) {
  if (typeof reads?.getItem !== 'function' || typeof reads?.acceptedVerdict !== 'function') {
    throw new TypeError('merge-only preparation requires explicit getItem and acceptedVerdict read ports');
  }
  if (options?.gateGreen !== true || itemPatchDigest(board, id) !== null) return null;
  // An absent item remains a replay-time refusal, not a new pre-transport policy.
  const held = board.db.prepare('SELECT * FROM item WHERE item_id = ?').get(id);
  const basis = held ? mergeOnlyBasis(board, held, {}, reads) : null;
  if (!basis) return null;
  const item = reads.getItem(board, id);
  return !retainedVerifierIdentityProblem(board, item, basis.by, reads.identity)
    && mergeOnlySourceValid(board.gitRoot, board, item, {}, reads)
    ? deriveMergeOnly(board.gitRoot, basis, options) : null;
}
