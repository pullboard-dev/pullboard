/** @pullboard-test-input source-cell packages/state */
/** CLAIM_CHECK_CEILING_ENGINE is exported by the state door as one number above MERGED_AT_ENGINE, and the claim move declares CHECK_OVER_CEILING [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as full from '../../../index.js';
import { MOVES } from '../../../src/logic/machine/move/claim.js';

test('state.engines-claim-check-ceiling.leaf-numbered: clause 1: CLAIM_CHECK_CEILING_ENGINE is a number above MERGED_AT_ENGINE and the claim move lists CHECK_OVER_CEILING [C7]', () => {
  assert.equal(typeof full.CLAIM_CHECK_CEILING_ENGINE, 'number');
  assert.ok(full.CLAIM_CHECK_CEILING_ENGINE > full.MERGED_AT_ENGINE, `${full.CLAIM_CHECK_CEILING_ENGINE} is above MERGED_AT_ENGINE`);
  const codes = MOVES.find(move => move.verb === 'claim').alsoRefuses.map(row => row.code);
  assert.ok(codes.includes('CHECK_OVER_CEILING'), 'claim alsoRefuses names CHECK_OVER_CEILING');
});
