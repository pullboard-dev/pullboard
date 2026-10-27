/** Faithful clause-bearing defaults for the existing board verdict fixture [V6,H16]. */
import * as store from '../src/board.js';
import { REJECT_CLAUSE_ENGINE } from '../src/reject-clause-engine.js';

/**
 * A verdict with the defaults a correct verifier would pass.
 */
export const verifyFrozenFixture = (board, id, fields) =>
  store.verify(board, id, { head: 'a'.repeat(40), digest: 'digest:Page', policy: 'any', note: 'broke the fix; its test failed; restored it',
    ...(fields.decision === 'REJECT' && (board.executionEngineVersion ?? REJECT_CLAUSE_ENGINE) >= REJECT_CLAUSE_ENGINE
      ? { clause: store.getItem(board, id).item_title } : {}), ...fields });
