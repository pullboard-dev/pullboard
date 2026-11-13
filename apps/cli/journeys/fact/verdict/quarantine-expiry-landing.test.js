/** Native quarantine journey: twenty executed passes close the exception and the landing batch readers refuse it [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runQuarantinePhases } from '../../../tests/fixtures/cases/quarantine-verdict.js';

test('twenty executed passes close the exception and the landing batch readers refuse it [C7,H16]', async t => {
  const phases = ['mixed', 'batch', 'close', 'closeL'];
  assert.deepEqual(await runQuarantinePhases(t, phases), phases);
});
