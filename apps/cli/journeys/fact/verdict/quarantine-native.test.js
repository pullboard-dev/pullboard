/** Native quarantine journey: native proof receipt keeps raw exit one and source advance accepts it [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runQuarantinePhases } from '../../../tests/fixtures/cases/quarantine-verdict.js';

test('native proof receipt keeps raw exit one and source advance accepts it [C7,H16]', async t => {
  const phases = ['gate', 'native'];
  assert.deepEqual(await runQuarantinePhases(t, phases), phases);
});
