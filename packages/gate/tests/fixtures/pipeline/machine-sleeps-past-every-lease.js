/**
 * Invariant: when the machine sleeps past every lease, all leases lapse at once, the next command's fallback and the
 * dispatcher retake them, and no job is driven for an item that moved on meanwhile [C7].
 * Repro: handoff drive jobs for items since verified or withdrawn sat lapsed for 37-41 h because every `next` and
 * `status` took their lease and renewed it. The fallback now ends such a job withdrawn and stale, and drives only
 * jobs whose item is still submitted at their candidate.
 * Runs on a real SQLite board with the production job store; the drive is a recording stub.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { from } from './kit.js';
import { hopCheck } from './kit.js';
import { lapsedGateJobs } from '../../../../drive/index.js';
import { reclaimPass } from '../../../../drive/index.js';
import { LEASE_MS } from '../../../../jobs/index.js';
import { createJob } from '../../../../jobs/index.js';
import { jobView } from '../../../../jobs/index.js';
import { reclaimLapsed } from '../../../../jobs/index.js';
import { takeJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';

const { cellBoard } = await from('packages/board/tests/fixtures/cell-board.js');

// Ten minutes: past every two-minute lease, short of the 20 minutes with no step that ends a gate job as infrastructure.
const SLEPT = 10 * 60_000;

test('after a sleep past every lease the fallback ends the job whose item moved on and drives only the live one [C7]', async t => {
  await hopCheck('sleep-past-leases', async () => {
    const { db } = cellBoard(t, ':memory:');
    const start = 1_000_000;
    for (const [id, item] of [['gate:live', 1], ['gate:moved-on', 2], ['gate:other-live', 3]]) {
      // Each lease is taken a second after the last, so "oldest lapse first" names one job.
      const at = start + item * 1000;
      createJob(db, { id, kind: 'gate', item, candidate: `c${item}`, now: at });
      writeStep(db, id, 'shard.started', {}, { now: at });
      assert.equal(takeJob(db, id, 'dead-driver', { now: at }).taken, true);
    }
    const now = start + SLEPT;
    assert.equal(reclaimLapsed(db, { now }).length, 3, 'every lease lapsed at once');
    const driven = [];
    const lapsed = lapsedGateJobs(db, { now });
    const pass = await reclaimPass(db, { owner: 'next-command', now: () => now, lapsed, active: view => view.item !== 2,
      drive: async (_db, job) => { driven.push(job); return { transition: 'shard.collected', phase: 'running' }; } });
    const moved = jobView(db, 'gate:moved-on');
    assert.equal(moved.step, 'done', 'the job whose item moved on is ended, not retaken');
    assert.equal(moved.steps.find(step => step.name === 'withdrawn').payload.stale, true);
    assert.equal(moved.leaseOwner, null);
    assert.deepEqual(driven, ['gate:live'], 'one live job is driven by one transition, oldest lapse first, and never the moved-on one');
    assert.equal(pass.lapsed, 2);
    assert.ok(!driven.includes('gate:moved-on'), 'no job is driven for an item that moved on');
    assert.deepEqual(lapsedGateJobs(db, { now }).map(job => job.id).includes('gate:moved-on'), false, 'it is never listed again');
    assert.ok(LEASE_MS > 0);
    return { measured: 'three leases lapsed at once; one live job driven, the moved-on job ended' };
  });
});
