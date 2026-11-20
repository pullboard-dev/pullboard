/** The store light door loads cold inside its 100 ms light-door budget [C7]. */
/** @pullboard-test-timing */
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('store.io-light-load.packages-store-light-js-loads-cold: clause 2: packages/store/light.js loads cold in under 100 ms of module work [C7]', async () => {
  // This file imports nothing else, so the door and everything it reaches load for the first time here.
  // CPU time (user plus system) of this process, not the wall clock, so a loaded runner does not fail the case.
  const before = process.cpuUsage();
  await import('../../light.js');
  const used = process.cpuUsage(before);
  const ms = (used.user + used.system) / 1000;
  console.log(`store light door cold load: ${ms.toFixed(1)} ms of CPU`);
  assert.ok(ms < 100, `${ms} ms`); // budget: declared light-door budget, 100 ms
});
