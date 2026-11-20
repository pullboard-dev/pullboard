/** A second runner id claiming from the same host and runner folder is refused inside the gap, and the adapter passes the claim place on [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { claimJob } from '../../../index.js';
import { jobQueueCall } from '../../../index.js';

/** An empty board for one case. */
function board(t, name) {
  const { root } = privateFixtureFiles(`pullboard-place-${name}-`);
  return cellBoard(t, join(root, 'board.sqlite')).db;
}

test('api.io-jobs-place.runner-duplicate-refused: clause 1: a second runner id with the same place as one that claimed 29 s earlier is refused RUNNER_DUPLICATE naming both ids [C7]', (t) => {
  const db = board(t, 'duplicate');
  const place = { host: 'mini-one', root: '/runner/one' };
  claimJob(db, { runner: 'runner-a', place, now: 1000 });
  assert.throws(() => claimJob(db, { runner: 'runner-b', place, now: 30_000 }),
    error => error.code === 'RUNNER_DUPLICATE' && error.message.includes('runner-a') && error.message.includes('runner-b'));
});

test('api.io-jobs-place.second-id-after-gap: clause 2: a second runner id from the same place claims as today once the first id has not claimed for 30 s [C7]', (t) => {
  const db = board(t, 'gap');
  const place = { host: 'mini-two', root: '/runner/two' };
  claimJob(db, { runner: 'runner-a', place, now: 1000 });
  assert.equal(claimJob(db, { runner: 'runner-b', place, now: 31_000 }), null);
  assert.equal(claimJob(db, { runner: 'runner-c', place: { host: 'mini-two', root: '/runner/other' }, now: 31_001 }), null);
});

test('api.io-jobs-place.adapter-passes-place: clause 3: the adapter jobs call passes the claim place to claimJob, and a claim without a place claims as today [C7]', (t) => {
  const db = board(t, 'adapter');
  const place = { host: 'mini-three', root: '/runner/three' };
  const call = (runner, withPlace, now) => jobQueueCall(db, { action: 'claim', runner, ...(withPlace ? { place } : {}) }, { mode: 'pull', now });
  assert.equal(call('runner-a', true, 1000).claim, null);
  assert.throws(() => call('runner-b', true, 2000), error => error.code === 'RUNNER_DUPLICATE');
  assert.equal(call('runner-b', false, 2001).claim, null);
});
