/** @pullboard-world-pin: clause 1 reads the outbox undo test and the relay checkpoint journey sources to prove the move. */
/** Importing the checkpoint worker entry starts nothing, so only invoking the worker file may publish [H5,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('importing the checkpoint process entry does not start a publisher [H5,C7]', async () => {
  await assert.doesNotReject(() => import('../src/io/worker/checkpoint/relay.js'), 'only invoking the worker file may read process board arguments or publish');
});

test('clause 1: the seven undo cases stay in the outbox cell and the worker-import case left the journey [C7]', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const titles = (source) => [...source.matchAll(/^test\('([^']+)'/gmu)].map(match => match[1]);
  assert.equal(titles(read('../../../packages/outbox/tests/io/relay/undo.test.js')).length, 7, 'the seven undo cases keep their place');
  assert.deepEqual(titles(read('../../cli/journeys/relay/checkpoint.test.js')).filter(title => title.startsWith('importing the checkpoint process entry')), [], 'the journey no longer holds the import case');
});
