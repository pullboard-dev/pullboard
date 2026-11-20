/** the pulled-gate follower's GATE_RED refusal prints the same failing-case lines as show, so the output line of a crashed file reaches the builder [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForPulledGate as followPulledGate } from '../../../src/io/submit/pulled.js';

/** Ports that answer one done, red gate job whose only failing case carries the generic node --test error. */
function redPorts() {
  const gate = { green: false, phases: [{ role: 'proof', status: 1, errors: [{ file: 'test/a.test.js', name: 'a.test.js', error: 'test failed' }],
    tail: '# Subtest: a.test.js\n# ReferenceError: describe is not defined' }] };
  return {
    withBoardRead: (ctx, read) => read({ db: null }),
    retrySync: async () => {},
    getItem: () => ({ item_id: 7, item_status: 'claimed' }),
    newestGateJob: () => ({ id: 'gate:7', step: 'done', gate }),
  };
}

test('cli.io-submit-pulled.generic-error-refusal-names-output-line: clause 3: the GATE_RED refusal for a generic "test failed" case contains the output error line [C7]', async () => {
  const ctx = { io: { say: () => {} } };
  let refusal = null;
  try { await followPulledGate(ctx, 7, { gateJob: 'gate:7', commit: 'c'.repeat(40) }, redPorts()); } catch (error) { refusal = error; }
  assert.equal(refusal?.code, 'GATE_RED');
  assert.match(refusal.message, /a\.test\.js :: a\.test\.js: ReferenceError: describe is not defined/u);
  assert.doesNotMatch(refusal.message, /: test failed/u);
});
