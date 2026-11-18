/** A gone fallback owner cannot leave the recorded stale gate shard held [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { withFixtureBoard } from '../../fixtures/board.js';
import { createJob } from '../../../../../packages/jobs/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { takeJob } from '../../../../../packages/jobs/index.js';
import { writeStep } from '../../../../../packages/jobs/index.js';
import { reclaimPass } from '../../../../../packages/drive/index.js';

test('cli.io-gate-stale-shard-3179.a-gone-fallback-owner-releases-item-3179: a gone fallback owner releases item 3179 stale shard within the gate budget [C7]', async () => {
  const files = privateFixtureFiles('pullboard-stale-shard-3179-');
  const now = Date.now();
  const old = now - 41 * 60 * 60_000;
  const id = 'handoff-drive-451ea3a5-fb29-4ba1-ae9c-39834a511f8c';
  await withFixtureBoard(join(files.root, 'board.sqlite'), async board => {
    createJob(board.db, { id, kind: 'gate', item: 3179, candidate: 'a'.repeat(40), now: old });
    writeStep(board.db, id, 'shard.started', { shard: 's1' }, { now: old });
    assert.equal(takeJob(board.db, id, 'fallback:next:66406', { now: old, leaseMs: 120_000 }).taken, true);
    const started = performance.now();
    let driven = false;
    await reclaimPass(board.db, { owner: 'fallback:next:2', now: () => now, active: () => false,
      drive: async () => { driven = true; } });
    const elapsed = performance.now() - started;
    const job = jobView(board.db, id);
    assert.equal(driven, false, 'the stale shard is not driven again');
    assert.equal(job.step, 'done');
    assert.equal(job.leaseOwner, null);
    assert.ok(job.steps.some(step => step.name === 'withdrawn' && step.payload.stale === true));
    assert.ok(elapsed < 5 * 60_000, `stale gate ended after ${elapsed} ms`); // budget: the unchanged gate progress limit.
  });
});
