/** @pullboard-test-input packages/items/index.js */
/** A rebuilt landing batch records the base it left; any other base change is refused [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateLandingRevision } from '../../../../../packages/items/index.js';

test('a rebuilt batch records the base it left and passes the revision guard; any other base change is refused [C7]', () => {
  const previous = { revision: 3, state: 'gating', base: 'a'.repeat(40), root: '/w', branch: 'refs/heads/main' };
  const rebuilt = { ...previous, base: 'b'.repeat(40), rebasedFrom: 'a'.repeat(40) };
  assert.doesNotThrow(() => validateLandingRevision(previous, rebuilt, 3));
  const other = { ...previous, base: 'c'.repeat(40) };
  assert.throws(() => validateLandingRevision(previous, other, 3), error => error.code === 'LAND_BATCH');
  const forged = { ...previous, base: 'c'.repeat(40), rebasedFrom: 'd'.repeat(40) };
  assert.throws(() => validateLandingRevision(previous, forged, 3), error => error.code === 'LAND_BATCH');
});
