/** A locked database while a runner produces the cells inventory is retried; one that stays locked is an infrastructure stop [C7,#8415]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INVENTORY_LOCK_RETRIES } from '../../../src/io/inventory.js';
import { retryLockedProduction } from '../../../src/io/inventory.js';
import { submitUntilSettled } from '../../../src/io/requeue.js';

/** The error the producer's file lock raises when another gate holds it past its wait. */
const locked = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });

test('clause 1: a locked database while producing the cells inventory is retried with back-off until the production finishes [C7]', async () => {
  const pauses = [];
  let calls = 0;
  const made = await retryLockedProduction(async () => { if (++calls <= 2) throw locked(); return { available: true }; }, { pause: async ms => { pauses.push(ms); }, pauseMs: 100 });
  assert.deepEqual(made, { available: true });
  assert.equal(calls, 3, 'the production ran again after each lock');
  assert.deepEqual(pauses, [100, 200]);
});

test('clause 1: a failure that is not a lock goes up on its first run, so a real red is never retried away [C7]', async () => {
  let calls = 0;
  await assert.rejects(retryLockedProduction(async () => { calls += 1; throw new Error('checker found a cell cycle'); }, { pause: async () => {} }), /cell cycle/u);
  assert.equal(calls, 1);
});

test('clause 2: an inventory that stays locked is retried a bounded number of times, then stops with the lock error [C7]', async () => {
  let calls = 0;
  await assert.rejects(retryLockedProduction(async () => { calls += 1; throw locked(); }, { pause: async () => {} }), /database is locked/u);
  assert.equal(calls, INVENTORY_LOCK_RETRIES + 1);
});

test('clause 2: a pending inventory that cannot be produced requeues the same candidate as infrastructure and ends as an infrastructure stop, never a red [C7]', async () => {
  const pending = Object.assign(new Error('accepted cells inventory was not produced on the runner: database is locked'),
    { name: 'CellsInventoryInfrastructureError', code: 'CELLS_INVENTORY_PENDING', retryable: true, commit: 'a'.repeat(40) });
  const reruns = [];
  let attempts = 0;
  await assert.rejects(submitUntilSettled(async () => { attempts += 1; throw pending; },
    { say: () => {}, wait: async () => {}, pauseMs: 0, noRunnerPauseMs: 0, onInfrastructure: async rerun => { reruns.push(rerun.code); } }),
  error => { assert.equal(error.code, 'GATE_INFRA_EXHAUSTED'); return true; });
  assert.ok(attempts > 1, 'the candidate ran again before the stop');
  assert.ok(reruns.every(code => code === 'CELLS_INVENTORY_PENDING'));
});
