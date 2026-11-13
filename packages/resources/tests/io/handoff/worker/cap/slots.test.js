/** With runnersOnly the handoff worker cap is every runner slot, and a running dispatcher picks up a raised cap [C7,#3061]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffWorkerCapacity } from '../../../../../index.js';

test('with runnersOnly the worker cap follows the runner slots up to the machine bound: 9 for one runner of 9, 16 for 7 of them [C7,#3061]', () => {
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 10, runnerSlots: 9, runnersOnly: true }), 9);
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 10, runnerSlots: 63, runnersOnly: true }), 16, 'each worker holds a process pair on this machine for its gate, so the fleet never raises it past the bound');
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 10, runnerSlots: 63 }), 12, 'without runnersOnly one per five slots still applies');
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 4, runnerSlots: 0, runnersOnly: true }), 4, 'no runners leaves the local cap');
  assert.equal(handoffWorkerCapacity({ env: { PULLBOARD_HANDOFF_WORKERS: '5' }, cores: 10, runnerSlots: 63, runnersOnly: true }), 5, 'the override still wins');
});
