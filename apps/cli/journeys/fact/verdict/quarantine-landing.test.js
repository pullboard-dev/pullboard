/** Native quarantine journey: landing batch and local guards keep raw red under an active quarantine [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runQuarantinePhases } from '../../../tests/fixtures/cases/quarantine-verdict.js';

test('landing batch and local guards keep raw red under an active quarantine [C7,H16]', async t => {
  const phases = ['land', 'batch', 'guard'];
  assert.deepEqual(await runQuarantinePhases(t, phases), phases);
});
