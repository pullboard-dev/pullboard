/** A push shard whose pre-push gate is gone ends at its next claim, and a gate's withdrawn shards are never claimed again [C7,#7805]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { PUSH_ALIVE_MS } from '../../index.js';
import { SHARD_JOB_KIND } from '../../index.js';
import { claimJob } from '../../index.js';
import { endJobs } from '../../index.js';
import { jobViews } from '../../index.js';
import { keepJobsAlive } from '../../index.js';
import { offerJob } from '../../index.js';

const boardWith = t => cellBoard(t, ':memory:').db;
const offerPush = (db, id, now) => offerJob(db, { id, kind: SHARD_JOB_KIND, priority: 'gate', now });

test('api.push-shards-end.endjobs-ends-every-unfinished-shard: clause 1: endJobs ends every unfinished shard at once, even one a runner holds, and no runner claims it again [C7,#7805]', t => {
  const db = boardWith(t);
  for (let at = 1; at <= 4; at += 1) offerPush(db, `push:abc:tag:shard:${at}`, 1_000);
  const held = claimJob(db, { runner: 'r1', now: 1_001 });
  const ids = [1, 2, 3, 4].map(at => `push:abc:tag:shard:${at}`);
  assert.deepEqual(endJobs(db, ids, { now: 1_002 }).sort(), ids, 'all four end, the held one too');
  assert.ok(jobViews(db, ids).every(view => view.step === 'done' && view.steps.some(step => step.name === 'withdrawn')));
  assert.deepEqual(endJobs(db, ids, { now: 1_003 }), [], 'a second withdrawal ends nothing');
  for (const runner of ['r1', 'r2', 'r3']) assert.equal(claimJob(db, { runner, now: 1_004 + PUSH_ALIVE_MS * 0 }), null, `${runner} finds nothing to claim`);
  assert.ok(held, 'the held shard had been claimed once');
});

test('api.push-shards-end.push-shard-unrenewed-past-alive: clause 2: a push shard unrenewed past the alive window ends on its next claim attempt, not rerun, while a renewed one is claimed [C7,#7805]', t => {
  const db = boardWith(t);
  offerPush(db, 'push:dead:tag:shard:1', 1_000);
  offerPush(db, 'push:live:tag:shard:1', 1_000);
  const now = 1_000 + PUSH_ALIVE_MS + 1;
  keepJobsAlive(db, ['push:live:tag:shard:1'], now - 10_000);
  const claim = claimJob(db, { runner: 'r1', now });
  assert.equal(claim.job, 'push:live:tag:shard:1', 'the renewed shard is the one a runner takes');
  const [dead] = jobViews(db, ['push:dead:tag:shard:1']);
  assert.equal(dead.step, 'done');
  assert.ok(dead.steps.some(step => step.name === 'abandoned'), 'ended as abandoned');
  assert.equal(claimJob(db, { runner: 'r2', now: now + 1 }), null, 'nothing is left to rerun');
});

test('api.push-shards-end.shard-claimed-again-again-gate: clause 2: a shard claimed again and again with its gate gone ends on the next claim, with no attempt cap needed [C7,#7805]', t => {
  const db = boardWith(t);
  offerPush(db, 'push:old:tag:shard:1', 1_000);
  const first = claimJob(db, { runner: 'r1', now: 1_001, leaseMs: 10 });
  assert.equal(first.attempt, 1);
  assert.equal(claimJob(db, { runner: 'r2', now: 1_000 + PUSH_ALIVE_MS + 5 }), null, 'its lease lapsed and its gate is gone: ended, not claimed an attempt 2');
  assert.equal(jobViews(db, ['push:old:tag:shard:1'])[0].step, 'done');
});

test('api.push-shards-end.only-push-shards-ended-missing: clause 2: only push shards are ended for a missing gate; an old item gate shard and a test job stay claimable [C7,#7805]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:item:shard:1', kind: SHARD_JOB_KIND, now: 1_000 });
  offerJob(db, { id: 'test:run-1', kind: 'test', now: 1_000 });
  const now = 1_000 + PUSH_ALIVE_MS * 3;
  const taken = [claimJob(db, { runner: 'r1', now }), claimJob(db, { runner: 'r1', now })].map(claim => claim?.job).sort();
  assert.deepEqual(taken, ['gate:item:shard:1', 'test:run-1']);
});
