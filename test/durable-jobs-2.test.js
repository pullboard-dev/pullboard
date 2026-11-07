/** Durable gate 2/20: job leases, take, renew and reclaim [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { privateFixtureFiles } from './fixture-child.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { createJob, takeJob, renewLease, reclaimLapsed, LEASE_MS } from '../packages/jobs/index.js';

const files = privateFixtureFiles('pullboard-durable-jobs-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoard(name, body) {
  const board = openBoard(join(files.root, `${name}.sqlite`));
  try { return body(board.db); } finally { closeBoard(board); }
}

test('clause 1: takeJob succeeds only when the lease has lapsed [C7]', () => {
  withBoard('take', (db) => {
    createJob(db, { id: 'j1', kind: 'gate', now: 1000 });
    assert.equal(takeJob(db, 'j1', 'driver-a', { now: 1000 }).taken, true);
    const second = takeJob(db, 'j1', 'driver-b', { now: 1000 + LEASE_MS - 1 });
    assert.equal(second.taken, false);
    assert.equal(second.job.leaseOwner, 'driver-a');
    const third = takeJob(db, 'j1', 'driver-b', { now: 1000 + LEASE_MS + 1 });
    assert.equal(third.taken, true);
    assert.equal(third.job.leaseOwner, 'driver-b');
    assert.throws(() => takeJob(db, 'absent', 'driver-a'), { code: 'JOB_MISSING' });
  });
});

test('clause 2: renewLease moves lease_until only for the holder with a live lease [C7]', () => {
  withBoard('renew', (db) => {
    createJob(db, { id: 'j2', kind: 'gate', now: 0 });
    takeJob(db, 'j2', 'driver-a', { now: 10_000 });
    assert.equal(renewLease(db, 'j2', 'driver-a', { now: 15_000 }), true);
    assert.equal(db.prepare('SELECT job_lease_until FROM job WHERE job_id = ?').get('j2').job_lease_until, 15_000 + LEASE_MS);
    assert.equal(renewLease(db, 'j2', 'driver-b', { now: 16_000 }), false);
    assert.equal(renewLease(db, 'j2', 'driver-a', { now: 15_000 + LEASE_MS + 1 }), false);
  });
});

test('clause 3: reclaimLapsed returns taken jobs whose lease lapsed, 2 minutes after the last renewal [C7]', () => {
  withBoard('reclaim', (db) => {
    for (const id of ['queued', 'live', 'silent']) createJob(db, { id, kind: 'gate', now: 0 });
    takeJob(db, 'live', 'a', { now: 50_000 });
    takeJob(db, 'silent', 'a', { now: 1 });
    renewLease(db, 'silent', 'a', { now: 10_000 });
    assert.deepEqual(reclaimLapsed(db, { now: 10_000 + LEASE_MS }), [], 'at the lease end it is still held');
    const lapsed = reclaimLapsed(db, { now: 10_000 + LEASE_MS + 1 });
    assert.deepEqual(lapsed.map(job => job.id), ['silent'], 'one ms after 2 minutes of silence it is reclaimable; queued and live are not');
    assert.equal(lapsed[0].lapsedMs, 1);
    assert.equal(reclaimLapsed(db, { now: 50_000 + LEASE_MS + 1 }).length, 2);
  });
});
