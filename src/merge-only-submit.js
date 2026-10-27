/** Writer-only carry preparation stays outside the read-side verdict import graph [C7,V4,H16]. */
import { deriveMergeOnly } from './merge-only-source.js';
import {
  mergeOnlyBasis,
  mergeOnlySourceValid,
} from './merge-only-verdict.js';
import { retainedVerifierIdentityProblem } from './item-authors.js';
import { getItem } from './board-query.js';

/** Derive the origin’s carry before sealing; caller-supplied carry facts are discarded. */
export function prepareMergeOnlySubmit(board, id, options) {
  if (options?.gateGreen !== true) return null;
  // An absent item remains a replay-time refusal, not a new pre-transport policy.
  const held = board.db.prepare('SELECT * FROM item WHERE item_id = ?').get(id);
  const basis = held ? mergeOnlyBasis(board, held) : null;
  if (!basis) return null;
  const item = getItem(board, id);
  return !retainedVerifierIdentityProblem(board, item, basis.by)
    && mergeOnlySourceValid(board.gitRoot, board, item)
    ? deriveMergeOnly(board.gitRoot, basis, options) : null;
}
