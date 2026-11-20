/** A --review-family item refuses a seat of another family, unless review.relaxRequiredFamily is on and a relaxation witness exists for it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused } from '../../../../kernel/light.js';
import { requiredFamilyStands } from '../../../src/logic/review/eligibility.js';

const WITNESS = { version: 1, threshold: 2, queueLength: 2, waiting: [1, 2], activeSeats: [], at: '2026-01-01T00:16:00.000Z' };
const ITEM = { item_id: 1 };
const REFUSAL = new Refused('REQUIRED_REVIEW_FAMILY', '#1 requires reviewer family anthropic');

test('verify.logic-review-eligibility.relaxed-family-witness: clause 1: with review.relaxRequiredFamily on and a relaxation witness for the item, the required-family refusal does not stand for a seat of another session [C7]', () => {
  const seen = [];
  const witness = (board, item, agentId) => { seen.push([item.item_id, agentId]); return WITNESS; };
  assert.equal(requiredFamilyStands(REFUSAL, {}, ITEM, 'core-2', { relaxRequiredFamily: true, requiredFamilyWitness: witness }), null);
  assert.deepEqual(seen, [[1, 'core-2']]);
});

test('verify.logic-review-eligibility.required-family-refused: clause 2: without a witness, or with the setting off, the required-family refusal stands as today [C7]', () => {
  assert.equal(requiredFamilyStands(REFUSAL, {}, ITEM, 'core-2'), REFUSAL);
  assert.equal(requiredFamilyStands(REFUSAL, {}, ITEM, 'core-2', { relaxRequiredFamily: true, requiredFamilyWitness: () => null }), REFUSAL);
  assert.equal(requiredFamilyStands(REFUSAL, {}, ITEM, 'core-2', { relaxRequiredFamily: false, requiredFamilyWitness: () => WITNESS }), REFUSAL);
  assert.equal(requiredFamilyStands(null, {}, ITEM, 'core-2', { relaxRequiredFamily: true, requiredFamilyWitness: () => WITNESS }), null);
});
