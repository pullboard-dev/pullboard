/** The store light door loads cold inside its 100 ms light-door budget [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('store.io-light-load.packages-store-light-js-loads-cold: clause 2: packages/store/light.js loads cold in under 100 ms of module work [C7]', async () => {
  // This file imports nothing else, so the door and everything it reaches load for the first time here.
  const started = performance.now();
  await import('../../light.js');
  const ms = performance.now() - started;
  console.log(`store light door cold load: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 100, `${ms} ms`); // budget: declared light-door budget, 100 ms
});
