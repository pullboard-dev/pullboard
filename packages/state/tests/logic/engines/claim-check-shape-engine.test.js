/** @pullboard-test-input source-cell packages/state */
/** CLAIM_CHECK_SHAPE_ENGINE is exported by the state door as a number above CLAIM_CHECK_CEILING_ENGINE, and the claim move declares CHECK_UNSOUND [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as full from '../../../index.js';
import { MOVES } from '../../../src/logic/machine/move/claim.js';

test('state.engines-claim-check-shape.leaf-numbered: clause 1: CLAIM_CHECK_SHAPE_ENGINE is a number above CLAIM_CHECK_CEILING_ENGINE and the claim move lists CHECK_UNSOUND [C7]', () => {
  assert.equal(typeof full.CLAIM_CHECK_SHAPE_ENGINE, 'number');
  assert.ok(full.CLAIM_CHECK_SHAPE_ENGINE > full.CLAIM_CHECK_CEILING_ENGINE, `${full.CLAIM_CHECK_SHAPE_ENGINE} is above CLAIM_CHECK_CEILING_ENGINE`);
  const codes = MOVES.find(move => move.verb === 'claim').alsoRefuses.map(row => row.code);
  assert.ok(codes.includes('CHECK_UNSOUND'), 'claim alsoRefuses names CHECK_UNSOUND');
});
