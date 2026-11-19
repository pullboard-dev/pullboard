/** A runner holds no more gate-shard jobs than its cores allow, so a gate's shards spread over every runner that polls [C7,#7765]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { SHARD_JOB_KIND } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';
import { shardClaimCap } from '../../index.js';
import { releaseJob } from '../../index.js';

const boardWith = t => cellBoard(t, ':memory:').db;

/** Offer `count` shard jobs of one dry push gate, oldest first. */
function offerShards(db, count) {
  for (let at = 1; at <= count; at += 1) offerJob(db, { id: `push:abc:tag:shard:${at}`, kind: SHARD_JOB_KIND, priority: 'gate', now: at });
}

test('api.shards.runner-takes-gate-shard-per: clause 1: a runner takes one gate shard per three cores and no more, so the other runners get the remaining shards [C7,#7765]', t => {
  const db = boardWith(t);
  offerShards(db, 18);
  const now = 1_000;
  const take = (runner, cores, jobs) => claimJob(db, { runner, cores, jobs, now });
  // Two fast runners with ten cores and ten slots each poll first, as .56 and .55 did.
  const taken = { r56: [], r55: [] };
  for (let tries = 0; tries < 18; tries += 1) for (const runner of ['r56', 'r55']) { const claim = take(runner, 10, 10); if (claim) taken[runner].push(claim.job); }
  assert.equal(shardClaimCap(10), 3);
  assert.deepEqual([taken.r56.length, taken.r55.length], [3, 3], 'each takes its cap of three, not eight or ten');
  // The four idle runners that polled later get the other twelve.
  const others = ['r51', 'r52', 'r53', 'r54'].map(runner => { const mine = []; for (let tries = 0; tries < 18; tries += 1) { const claim = take(runner, 10, 10); if (claim) mine.push(claim.job); } return mine.length; });
  assert.deepEqual(others, [3, 3, 3, 3], 'each idle runner takes three of the rest');
  assert.equal(take('r-late', 10, 10), null, 'all eighteen are held');
});

test('api.shards.finished-released-shard-frees-slot: clause 1: a finished or released shard frees a slot; a one-core runner holds one shard; a runner not reporting cores is not capped; other kinds are never capped [C7,#7765]', t => {
  const db = boardWith(t);
  offerShards(db, 6);
  const first = claimJob(db, { runner: 'r-small', cores: 2, now: 10 });
  assert.equal(shardClaimCap(2), 1, 'a runner holds at least one shard');
  assert.equal(claimJob(db, { runner: 'r-small', cores: 2, now: 11 }), null, 'a second shard waits for the first');
  releaseJob(db, { job: first.job, runner: 'r-small', token: first.token, reason: 'test', backoff: false, now: 12 });
  assert.ok(claimJob(db, { runner: 'r-small', cores: 2, now: 13 }), 'a free slot takes the next shard');
  const old = [claimJob(db, { runner: 'r-old', now: 14 }), claimJob(db, { runner: 'r-old', now: 15 })];
  assert.ok(old.every(Boolean), 'a runner that reports no cores keeps the old claim behaviour');
  offerJob(db, { id: 'gate:other', kind: 'gate', now: 20 });
  offerJob(db, { id: 'test:other', kind: 'test', now: 21 });
  const kinds = [claimJob(db, { runner: 'r-small', cores: 2, now: 22 }), claimJob(db, { runner: 'r-small', cores: 2, now: 23 })].map(claim => claim?.kind);
  assert.deepEqual(kinds.sort(), ['gate', 'test'], 'a runner at its shard cap still claims every other kind of job');
});

test('api.shards.runner-free-slot-takes-offered: clause 2: a runner with a free slot takes an offered push-gate shard before an item gate or a test job, and still stops at its shard cap [C7,#7790]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:item-1', kind: 'gate', now: 1 });
  offerJob(db, { id: 'test:run-1', kind: 'test', now: 2 });
  offerJob(db, { id: 'land:one', kind: 'land', now: 3 });
  offerShards(db, 2);
  const order = [1, 2, 3, 4, 5].map(at => claimJob(db, { runner: 'r-free', cores: 3, jobs: 5, now: 100 + at })?.job);
  assert.deepEqual(order.slice(0, 1), ['push:abc:tag:shard:1'], 'the shard comes first though every other job is older');
  assert.equal(order.includes('push:abc:tag:shard:2'), false, 'the cap of one shard per three cores holds (#7765)');
  assert.deepEqual(order.slice(1).sort(), ['gate:item-1', 'land:one', 'test:run-1', undefined].sort(), 'the capped runner still takes every other job');
});

test('api.shards.push-shard-first-under-priority: clause 2: a push shard is first under a priority reserve too, and a gate-shard job not named push: gets no such rank [C7,#7790]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'test:run-1', kind: 'test', priority: 'interactive', now: 1 });
  offerJob(db, { id: 'shard:other', kind: SHARD_JOB_KIND, now: 2 });
  offerJob(db, { id: 'push:abc:tag:shard:1', kind: SHARD_JOB_KIND, priority: 'gate', now: 3 });
  const reserve = { interactive: 0.25 };
  assert.equal(claimJob(db, { runner: 'r-a', jobs: 4, reserve, now: 10 }).job, 'push:abc:tag:shard:1', 'a reserve does not push a shard behind a test');
  assert.equal(claimJob(db, { runner: 'r-b', jobs: 4, now: 11 }).job, 'test:run-1', 'a gate-shard job outside a push gate keeps its place after a test');
});

test('api.shards.cores-per-shard-sets-cap: clause 1: shardClaimCap(10, 2) is 5 while claimJob given cores 10 and coresPerShard 2 hands one runner five gate shards, and with no coresPerShard it hands three [C7,#11867]', t => {
  assert.equal(shardClaimCap(10, 2), 5);
  assert.equal(shardClaimCap(10), 3);
  const held = (coresPerShard) => {
    const db = boardWith(t);
    offerShards(db, 8);
    let taken = 0;
    for (let tries = 0; tries < 8; tries += 1) if (claimJob(db, { runner: 'r-ten', cores: 10, jobs: 10, now: 1_000, ...(coresPerShard ? { coresPerShard } : {}) })) taken += 1;
    return taken;
  };
  assert.equal(held(2), 5);
  assert.equal(held(null), 3);
});
