/** The view sentinel checks landing liveness on its own timer [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServeSentinel } from '../index.js';
import { LANDING_LIVENESS_INTERVAL_MS } from '../index.js';

test('the view sentinel checks landing liveness every minute, inside the two minute bar [C7]', async () => {
  const timers = []; const recovered = [];
  const observer = startServeSentinel({ projects: () => [{ root: '/one' }, { root: '/one' }], enabled: () => true,
    every: () => ({ unref() {} }), cancel: () => {},
    liveEvery: (callback, ms) => { timers.push({ callback, ms }); return { unref() {} }; }, liveCancel: () => {},
    run: async () => {}, runCanary: async () => {}, canary: () => ({ close: async () => {} }),
    recover: async root => { recovered.push(root); } });
  const liveness = timers.find(timer => timer.ms === LANDING_LIVENESS_INTERVAL_MS);
  assert.ok(liveness && LANDING_LIVENESS_INTERVAL_MS <= 60_000, 'a pid check runs at least once a minute');
  await liveness.callback();
  assert.deepEqual(recovered, ['/one'], 'each board root is checked once per pass');
  await observer.close();
});
