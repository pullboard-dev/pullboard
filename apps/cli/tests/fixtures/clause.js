/** Faithful clause-bearing defaults for the existing board verdict fixture [V6,H16]. */
import * as store from '../../../../packages/store/index.js';
import assert from 'node:assert/strict';
import { REJECT_CLAUSE_ENGINE } from '../../../../packages/state/light.js';

/**
 * A verdict with the defaults a correct verifier would pass.
 */
export const verifyFrozenFixture = (board, id, fields) =>
  store.verify(board, id, { head: 'a'.repeat(40), digest: 'digest:Page', policy: 'any', note: 'broke the fix; its test failed; restored it',
    ...(fields.decision === 'REJECT' && (board.executionEngineVersion ?? REJECT_CLAUSE_ENGINE) >= REJECT_CLAUSE_ENGINE
      ? { clause: store.getItem(board, id).item_title } : {}), ...fields });

/** Acknowledge the actual repeated-clause hold through the same coordinator operation and caller options. */
export function acknowledgeClauseHold(board, id, options) {
  assert.ok(store.getItem(board, id).item_hold_reason, 'the repeated frozen clause is held');
  store.releaseItemHold(board, id, options);
}
