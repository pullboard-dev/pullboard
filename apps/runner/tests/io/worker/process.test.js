/** The runner worker's startup bridge retries a locked slot database instead of failing before READY [C7,#3086]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused } from '../../../../../packages/kernel/index.js';
import { retrySlotLocked } from '../../../src/io/worker/process.js';

test('a locked slot database during the startup bridge is retried, never a worker failure [C7]', async () => {
  const waits = [];
  let calls = 0;
  const lease = await retrySlotLocked({ transportLost: false }, async () => {
    calls += 1;
    if (calls <= 2) throw new Refused('SLOT_DB_LOCKED', 'fixture slot database is locked');
    return 'lease';
  }, { wait: async ms => waits.push(ms), pauseMs: 100 });
  assert.equal(lease, 'lease');
  assert.deepEqual(waits, [100, 200]);
});

test('other refusals and a spent retry budget still fail the startup step [C7]', async () => {
  await assert.rejects(retrySlotLocked({ transportLost: false }, async () => { throw new Refused('BAD_RESOURCE_CAPACITY', 'fixture'); }, { wait: async () => {} }),
    { code: 'BAD_RESOURCE_CAPACITY' });
  let calls = 0;
  await assert.rejects(retrySlotLocked({ transportLost: false }, async () => { calls += 1; throw new Refused('SLOT_DB_LOCKED', 'fixture'); }, { wait: async () => {}, tries: 3 }),
    { code: 'SLOT_DB_LOCKED' });
  assert.equal(calls, 3);
  await assert.rejects(retrySlotLocked({ transportLost: true }, async () => { throw new Refused('SLOT_DB_LOCKED', 'fixture'); }, { wait: async () => {} }),
    /transport was lost/u);
});
