/** Native quarantine journey: private verify, submit gate and composed companion keep raw red authority [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runQuarantinePhases } from '../../../tests/fixtures/cases/quarantine-verdict.js';

test('private verify, submit gate and composed companion keep raw red authority [C7,H16]', async t => {
  const phases = ['private', 'submit', 'companion'];
  assert.deepEqual(await runQuarantinePhases(t, phases), phases);
});
