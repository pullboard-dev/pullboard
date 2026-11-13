/** Native quarantine journey: twenty executed passes close the exception and every reader then refuses it [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runQuarantinePhases } from '../../../tests/fixtures/cases/quarantine-verdict.js';

test('twenty executed passes close the exception and every reader then refuses it [C7,H16]', async t => {
  const phases = ['gate', 'mixed', 'native', 'batch', 'private', 'tail'];
  assert.deepEqual(await runQuarantinePhases(t, phases), phases);
});
