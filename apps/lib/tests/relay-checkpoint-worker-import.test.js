/** Importing the checkpoint worker entry starts nothing, so only invoking the worker file may publish [H5,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('importing the checkpoint process entry does not start a publisher [H5,C7]', async () => {
  await assert.doesNotReject(() => import('../src/io/worker/checkpoint/relay.js'), 'only invoking the worker file may read process board arguments or publish');
});
