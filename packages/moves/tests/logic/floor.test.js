/** floorMax takes the largest engine number of every matching trigger, for every pair of the real floor triggers [H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTOMATIC_DISPATCH_ENGINE } from '../../../state/light.js';
import { BAR_ENGINE } from '../../../state/light.js';
import { CONFLICT_ENGINE } from '../../../state/light.js';
import { REVIEW_FAMILY_RELAX_ENGINE } from '../../../state/light.js';
import { floorMax } from '../../src/logic/floor.js';

const TRIGGERS = [REVIEW_FAMILY_RELAX_ENGINE, AUTOMATIC_DISPATCH_ENGINE, BAR_ENGINE, CONFLICT_ENGINE];

test('moves.floor.pair-max: clause 1: every pair of floor triggers returns the larger floor in either order, and a lone trigger returns its own [H16]', () => {
  for (const a of TRIGGERS) {
    for (const b of TRIGGERS) {
      assert.equal(floorMax([a, true], [b, true]), Math.max(1, a, b));
      assert.equal(floorMax([b, true], [a, true]), Math.max(1, a, b));
      assert.equal(floorMax([a, true], [b, false]), Math.max(1, a));
      assert.equal(floorMax([a, false], [b, true]), Math.max(1, b));
    }
  }
});

test('moves.floor.pair-none: clause 1: no matching trigger returns 1 [H16]', () => {
  assert.equal(floorMax(), 1);
  assert.equal(floorMax([REVIEW_FAMILY_RELAX_ENGINE, false], [CONFLICT_ENGINE, 0]), 1);
});
