/** The machine setting gate.handoffWorkers is applied by handoffWorkerCapacityDetail, the one function the dispatcher and library callers share [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffWorkerCapacityDetail } from '../../../../../index.js';

test('clause 1: the machine setting sets the cap, the environment override beats it, and a bad setting is ignored [C7]', () => {
  const base = { cores: 4, runnerSlots: 40, runnersOnly: false };
  assert.deepEqual(handoffWorkerCapacityDetail({ ...base, env: {}, machineCap: 3 }), { cap: 3, source: 'gate.handoffWorkers machine setting' });
  assert.equal(handoffWorkerCapacityDetail({ ...base, env: { PULLBOARD_HANDOFF_WORKERS: '7' }, machineCap: 3 }).cap, 7);
  assert.equal(handoffWorkerCapacityDetail({ ...base, env: {}, machineCap: 0 }).cap, 8, 'a setting below 1 falls back to one per five runner slots');
  assert.equal(handoffWorkerCapacityDetail({ ...base, env: {} }).cap, 8);
});
