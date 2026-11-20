/** Runner claim order: landing first; a runner holding no test job takes a test run, one holding a test job takes gate shards before further test runs, each in creation order [C7,#11146]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { addItem } from '../../../../store/index.js';
import { logEvent } from '../../../../store/index.js';
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

test('api.jobs-claim-order.aged-test-job-outranks-shards: clause 1: a runner holding a test job is handed a test job offered 2 minutes earlier before the queued shards, while a test job offered seconds earlier still yields to them [C7,#11190]', (t) => {
  const { root } = privateFixtureFiles('pullboard-claim-order-aged-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  for (let i = 1; i <= 40; i++) offerJob(db, { id: `gate:1:shard:${i}`, kind: 'gate-shard', now: 1000 + i });
  offerJob(db, { id: 'test:held', kind: 'test', now: 2000 });
  const claim = (now) => claimJob(db, { runner: 'r1', now, leaseMs: 600000 })?.job;
  assert.equal(claim(5000), 'test:held');
  offerJob(db, { id: 'test:aged', kind: 'test', now: 6000 });
  offerJob(db, { id: 'test:fresh', kind: 'test', now: 125_000 });
  assert.equal(claim(126_000), 'test:aged', 'a test job offered 2 minutes before the claim goes first');
  assert.equal(claim(126_001), 'gate:1:shard:1', 'the shards follow in their order');
  assert.equal(claim(126_002), 'gate:1:shard:2', 'a test job offered seconds before still yields to them');
});

test('api.jobs-claim-order.aged-census-test-job-yields-to-shards: clause 1: an aged census test job (its offer carries censusPerRunner) stays behind queued gate shards while an aged non-census test job moves ahead of them [C7,#11773]', (t) => {
  const { root } = privateFixtureFiles('pullboard-claim-order-census-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  for (let i = 1; i <= 5; i++) offerJob(db, { id: `gate:1:shard:${i}`, kind: 'gate-shard', now: 1000 + i });
  offerJob(db, { id: 'test:held', kind: 'test', now: 2000 });
  const claim = (now) => claimJob(db, { runner: 'r1', now, leaseMs: 600000 })?.job;
  assert.equal(claim(5000), 'test:held');
  offerJob(db, { id: 'test:census:aged', kind: 'test', censusPerRunner: 4, now: 5500 });
  offerJob(db, { id: 'test:review:aged', kind: 'test', now: 6000 });
  assert.equal(claim(126_000), 'test:review:aged', 'an aged non-census test job goes first');
  assert.equal(claim(126_001), 'gate:1:shard:1', 'the aged census job does not outrank the shards');
  for (let i = 2; i <= 5; i++) assert.equal(claim(126_001 + i), `gate:1:shard:${i}`);
  assert.equal(claim(126_100), 'test:census:aged', 'census runs once the shards are gone');
});

test('api.jobs-claim-order.aged-gate-job-outranks-shards: clause 1: a runner holding a test job is handed a gate job offered 6 minutes earlier before 40 queued shards, then the shards [C7,#11873]', (t) => {
  const { root } = privateFixtureFiles('pullboard-claim-order-gate-aged-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  for (let i = 1; i <= 40; i++) offerJob(db, { id: `gate:1:shard:${i}`, kind: 'gate-shard', now: 1000 + i });
  offerJob(db, { id: 'test:held', kind: 'test', now: 2000 });
  const claim = (now) => claimJob(db, { runner: 'r1', now, leaseMs: 900000 })?.job;
  assert.equal(claim(5000), 'test:held');
  offerJob(db, { id: 'gate:7', kind: 'gate', now: 10_000 });
  assert.equal(claim(370_000), 'gate:7', 'a gate job offered 6 minutes before the claim goes first');
  assert.equal(claim(370_001), 'gate:1:shard:1', 'the shards follow in their order');
});

test('api.jobs-claim-order.fresh-gate-job-and-landing: clause 2: a gate job offered 4 minutes before the claim stays behind the shards, and an aged gate job never outranks a landing job [C7,#11873]', (t) => {
  const { root } = privateFixtureFiles('pullboard-claim-order-gate-fresh-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  for (let i = 1; i <= 40; i++) offerJob(db, { id: `gate:1:shard:${i}`, kind: 'gate-shard', now: 1000 + i });
  offerJob(db, { id: 'test:held', kind: 'test', now: 2000 });
  const claim = (now) => claimJob(db, { runner: 'r1', now, leaseMs: 900000 })?.job;
  assert.equal(claim(5000), 'test:held');
  offerJob(db, { id: 'gate:7', kind: 'gate', now: 10_000 });
  assert.equal(claim(250_000), 'gate:1:shard:1', 'a gate job offered 4 minutes before stays behind the shards');
  offerJob(db, { id: 'land:1:x', kind: 'land', now: 300_000 });
  assert.equal(claim(370_000), 'land:1:x', 'a landing job outranks the aged gate job');
  assert.equal(claim(370_001), 'gate:7');
});

test('api.jobs-claim-order.expedited-item-shards-first: clause 1: an expedited item gets its gate shards before an aged test job and the older shards of another item, and once it leaves the expedited set its leftover shards queue by age again [C7,#11813]', (t) => {
  const { root } = privateFixtureFiles('pullboard-claim-order-expedited-');
  const board = cellBoard(t, join(root, 'board.sqlite'));
  const { db } = board;
  const one = addItem(board, { by: 'coordinator', lane: 'core', title: 'Ordinary item', route: 'strong' });
  const two = addItem(board, { by: 'coordinator', lane: 'core', title: 'Expedited item', route: 'strong' });
  for (let i = 1; i <= 40; i++) offerJob(db, { id: `gate:${one}:shard:${i}`, kind: 'gate-shard', item: one, now: 1000 + i });
  offerJob(db, { id: 'test:held', kind: 'test', now: 2000 });
  const claim = (now) => claimJob(db, { runner: 'r1', now, leaseMs: 900000 })?.job;
  assert.equal(claim(5000), 'test:held');
  offerJob(db, { id: 'test:aged', kind: 'test', now: 6000 });
  for (let i = 1; i <= 3; i++) offerJob(db, { id: `gate:${two}:shard:${i}`, kind: 'gate-shard', item: two, now: 7000 + i });
  logEvent(board, 'coordinator', 'expedite', two, { reason: 'blocks the lander' });
  assert.equal(claim(126_000), `gate:${two}:shard:1`, 'the expedited item goes first');
  assert.equal(claim(126_001), `gate:${two}:shard:2`);
  logEvent(board, 'coordinator', 'run_applied', two, { job: `gate:${two}:x` });
  assert.equal(claim(126_002), 'test:aged', 'the aged test job follows once the item leaves the expedited set');
  assert.equal(claim(126_003), `gate:${one}:shard:1`, 'the other item queues by age again');
});
