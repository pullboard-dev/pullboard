/** Native quarantine journey: twenty executed passes close the exception and the native proof and gate readers refuse it [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runQuarantinePhases } from '../../../tests/fixtures/cases/quarantine-verdict.js';

test('twenty executed passes close the exception and the native proof and gate readers refuse it [C7,H16]', async t => {
  const phases = ['gate', 'mixed', 'native', 'batch', 'receipts', 'close', 'closeN'];
  assert.deepEqual(await runQuarantinePhases(t, phases), phases);
});
