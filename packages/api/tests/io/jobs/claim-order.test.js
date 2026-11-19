/** Runner claim order: landing first; a runner holding no test job takes a test run, one holding a test job takes gate shards before further test runs, each in creation order [C7,#11146]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';

/** A board with 40 gate shards queued, then one newer test job. */
function queued(t) {
  const { root } = privateFixtureFiles('pullboard-claim-order-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  for (let i = 1; i <= 40; i++) offerJob(db, { id: `gate:1:shard:${i}`, kind: 'gate-shard', now: 1000 + i });
  offerJob(db, { id: 'test:abc:one', kind: 'test', now: 2000 });
  return db;
}

test('api.jobs-claim-order.next-claim-takes-newer-test: clause 1: a runner holding no test job takes a newer test job before queued gate shards, and one already holding a test job takes the shards next in their order, ahead of another newer test job [C7,#11146]', (t) => {
  const db = queued(t);
  const claim = (now) => claimJob(db, { runner: 'r1', now, leaseMs: 60000 })?.job;
  assert.equal(claim(5000), 'test:abc:one');
  offerJob(db, { id: 'test:abc:two', kind: 'test', now: 2500 });
  assert.equal(claim(5001), 'gate:1:shard:1');
  assert.equal(claim(5002), 'gate:1:shard:2');
});

test('api.jobs-claim-order.landing-job-outranks-both-test: clause 2: a landing job outranks both a test job and gate shards [C7]', (t) => {
  const db = queued(t);
  offerJob(db, { id: 'land:1:x', kind: 'land', now: 3000 });
  const claim = (now) => claimJob(db, { runner: 'r1', now, leaseMs: 60000 })?.job;
  assert.deepEqual([claim(5000), claim(5001), claim(5002)], ['land:1:x', 'test:abc:one', 'gate:1:shard:1']);
});
