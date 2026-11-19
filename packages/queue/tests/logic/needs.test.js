/** A pure check says which needs an agent lacks, and which need names are allowed [U136,C7,#1888]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingNeeds } from '../../src/logic/needs.js';
import { validateNeeds } from '../../src/logic/needs.js';

test('queue.needs.missing-needs-lists-what-is-lacking: clause 1: missingNeeds returns the needs an agent lacks, and an empty list when it has every one [C7]', () => {
  assert.deepEqual(missingNeeds(['browser', 'gui'], ['browser']), ['gui']);
  assert.deepEqual(missingNeeds(['browser', 'gui'], []), ['browser', 'gui']);
  assert.deepEqual(missingNeeds(['browser', 'gui'], ['gui', 'browser', 'extra']), []);
  assert.deepEqual(missingNeeds([], []), []);
});

test('queue.needs.validate-accepts-only-browser-and-gui: clause 2: validateNeeds accepts only browser and gui and refuses any other name with USAGE naming the allowed list [C7]', () => {
  assert.deepEqual(validateNeeds(['browser', 'gui']), ['browser', 'gui']);
  assert.deepEqual(validateNeeds([]), []);
  assert.throws(() => validateNeeds(['browser', 'gpu']), error => error.code === 'USAGE' && /browser and gui/u.test(error.message) && /gpu/u.test(error.message));
});
