/** A stale shard with a lapsed fallback lease ends within the gate progress budget [C7]. */
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

test('cli.io-gate-stale-shard-wait.a-lapsed-stale-shard-ends-within-the: a lapsed stale shard ends within the five-minute gate progress budget [C7]', async () => {
  const files = privateFixtureFiles('pullboard-stale-shard-wait-');
  const now = Date.now();
  const old = now - 38 * 60 * 60_000;
  const id = 'handoff-drive-stale-shard';
  await withFixtureBoard(join(files.root, 'board.sqlite'), async board => {
    createJob(board.db, { id, kind: 'gate', item: 2662, candidate: 'a'.repeat(40), now: old });
    writeStep(board.db, id, 'shard.started', { shard: 's1' }, { now: old });
    assert.equal(takeJob(board.db, id, 'fallback:next:2506', { now: old, leaseMs: 120_000 }).taken, true);
    const started = performance.now();
    let driven = false;
    await reclaimPass(board.db, { owner: 'fallback:next:2', now: () => now, active: () => false,
      drive: async () => { driven = true; } });
    const elapsed = performance.now() - started;
    const job = jobView(board.db, id);
    assert.equal(driven, false, 'a stale shard is not driven again');
    assert.equal(job.step, 'done');
    assert.equal(job.leaseOwner, null);
    assert.ok(job.steps.some(step => step.name === 'withdrawn' && step.payload.stale === true));
    assert.ok(elapsed < 5 * 60_000, `stale gate ended after ${elapsed} ms`); // budget: the item's unchanged five-minute gate progress limit.
  });
});
