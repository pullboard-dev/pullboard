/** A runner that offers no browser still serves a pulled gate whose selection needs none [C7,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { servedWithoutBrowser } from '../../../tests/fixtures/pull.js';

test('clause 2: a runner with PULLBOARD_CHROME=none serves a selection that declares no browser green [C7,P7]', { timeout: 150_000 }, // budget: one project, one submit and one served gate.
async t => {
  const gate = await servedWithoutBrowser(t, { path: 'web/plain.txt', body: 'plain\n' });
  assert.equal(gate.green, true, JSON.stringify(gate));
  assert.deepEqual(gate.phases.map(phase => [phase.role, phase.status]), [['check', 0], ['proof', 0]]);
});
