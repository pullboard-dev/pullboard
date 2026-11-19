/** The job store keeps one row per gate job or landing batch with an append-only, idempotent step log [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { holdBoard } from '../fixtures/hold-board.js';
import { atomically } from '../../index.js';
import { createJob } from '../../index.js';
import { setWriteHold } from '../../index.js';
import { jobView } from '../../index.js';
import { jobsOf } from '../../index.js';
import { leasedJobs } from '../../index.js';
import { nameJob } from '../../index.js';
import { takeJob } from '../../index.js';
import { writeStep } from '../../index.js';

/** A fresh in-memory board's SQLite handle, with the production job tables. */
const database = t => cellBoard(t, ':memory:').db;
const refused = code => error => error.code === code;

test('jobs.store.create-once: createJob stores a queued job once, and creating an id that exists returns the stored job unchanged [C7]', t => {
  const db = database(t);
  const made = createJob(db, { id: 'gate:1', kind: 'gate', item: 7, candidate: 'a'.repeat(40), base: 'b'.repeat(40), now: 1000 });
  assert.deepEqual({ id: made.id, kind: made.kind, item: made.item, step: made.step, attempt: made.attempt, leaseOwner: made.leaseOwner, created: made.created },
    { id: 'gate:1', kind: 'gate', item: 7, step: 'queued', attempt: 0, leaseOwner: null, created: 1000 });
  assert.deepEqual(made.steps, []);
  writeStep(db, 'gate:1', 'running', { host: 'mini' }, { now: 2000 });
  const again = createJob(db, { id: 'gate:1', kind: 'gate', item: 99, now: 3000 });
  assert.equal(again.item, 7, 'a repeat never rewrites the row');
  assert.equal(again.step, 'running', 'a repeat never resets a job that moved on');
  assert.throws(() => createJob(db, { id: '', kind: 'gate' }), refused('JOB_FIELDS'));
  assert.throws(() => createJob(db, { id: 'x' }), refused('JOB_FIELDS'));
});

test('jobs.store.name-fills-only: nameJob fills what a job lacked and never moves a named job onto another candidate [C7]', t => {
  const db = database(t);
  createJob(db, { id: 'gate:2', kind: 'gate', now: 1 });
  const named = nameJob(db, 'gate:2', { item: 4, candidate: 'c'.repeat(40) });
  assert.deepEqual([named.item, named.candidate, named.base], [4, 'c'.repeat(40), null]);
  const second = nameJob(db, 'gate:2', { item: 9, candidate: 'd'.repeat(40), base: 'e'.repeat(40) });
  assert.deepEqual([second.item, second.candidate, second.base], [4, 'c'.repeat(40), 'e'.repeat(40)]);
});

test('jobs.store.step-append-order: writeStep appends in order, the current step is the last written, and a repeat of the same key writes nothing [C7]', t => {
  const db = database(t);
  createJob(db, { id: 'gate:3', kind: 'gate', now: 1 });
  assert.deepEqual(writeStep(db, 'gate:3', 'running', { runner: 'one' }, { now: 10 }), { written: true, payload: { runner: 'one' } });
  assert.deepEqual(writeStep(db, 'gate:3', 'running', { runner: 'two' }, { now: 20 }), { written: false, payload: { runner: 'one' } }, 'the stored payload wins');
  assert.deepEqual(writeStep(db, 'gate:3', 'running', { runner: 'two' }, { seq: 1, now: 30 }), { written: true, payload: { runner: 'two' } }, 'a new seq is a new step');
  writeStep(db, 'gate:3', 'collected', undefined, { now: 40 });
  const view = jobView(db, 'gate:3');
  assert.equal(view.step, 'collected');
  assert.equal(view.updated, 40);
  assert.deepEqual(view.steps.map(step => [step.name, step.seq, step.payload, step.at]),
    [['running', 0, { runner: 'one' }, 10], ['running', 1, { runner: 'two' }, 30], ['collected', 0, {}, 40]]);
  assert.throws(() => writeStep(db, 'gate:3', ''), refused('JOB_STEP_NAME'));
  assert.throws(() => writeStep(db, 'gate:none', 'running'), refused('JOB_MISSING'));
});

test('jobs.store.step-joins-transaction: writeStep inside the caller\'s transaction joins it and rolls back with it [C7]', t => {
  const db = database(t);
  createJob(db, { id: 'gate:4', kind: 'gate', now: 1 });
  db.exec('BEGIN');
  writeStep(db, 'gate:4', 'running', {}, { now: 2 });
  assert.throws(() => writeStep(db, 'gate:missing', 'running'), refused('JOB_MISSING'), 'the savepoint rolls back only the failed write');
  db.exec('ROLLBACK');
  assert.deepEqual(jobView(db, 'gate:4').steps, []);
});

test('jobs.store.views-and-lists: jobView is null for an unknown job, and jobsOf lists one kind oldest first, optionally for one item [C7]', t => {
  const db = database(t);
  assert.equal(jobView(db, 'nope'), null);
  createJob(db, { id: 'b', kind: 'gate', item: 1, now: 20 });
  createJob(db, { id: 'a', kind: 'gate', item: 2, now: 20 });
  createJob(db, { id: 'c', kind: 'gate', item: 1, now: 10 });
  createJob(db, { id: 'd', kind: 'landing', item: 1, now: 5 });
  assert.deepEqual(jobsOf(db, { kind: 'gate' }).map(job => job.id), ['c', 'a', 'b'], 'created, then id');
  assert.deepEqual(jobsOf(db, { kind: 'gate', item: 1 }).map(job => job.id), ['c', 'b']);
  assert.deepEqual(jobsOf(db, { kind: 'none' }), []);
  assert.throws(() => jobsOf(db, {}), refused('JOB_FIELDS'));
});

test('jobs.store.leased-live-only: leasedJobs lists only a kind\'s jobs with a live lease that are not done [C7]', t => {
  const db = database(t);
  for (const id of ['live', 'lapsed', 'free', 'other']) createJob(db, { id, kind: id === 'other' ? 'landing' : 'gate', now: 1 });
  takeJob(db, 'live', 'w1', { now: 1000, leaseMs: 500 });
  takeJob(db, 'lapsed', 'w2', { now: 100, leaseMs: 100 });
  takeJob(db, 'other', 'w3', { now: 1000, leaseMs: 500 });
  assert.deepEqual(leasedJobs(db, { kind: 'gate', now: 1200 }).map(job => job.id), ['live']);
  assert.deepEqual(leasedJobs(db, { kind: 'gate', now: 1600 }), [], 'the lease lapsed');
  assert.throws(() => leasedJobs(db, {}), refused('JOB_FIELDS'));
});

/** A recording stub hold: every call lands in `calls` in order. */
function stubHold(calls) {
  return { prepare: () => { calls.push('prepare'); return 'marker'; }, begin: (db, marker) => { calls.push(`begin:${marker}`); return 'record'; },
    finish: (record, outcome) => calls.push(`finish:${record}:${outcome}`), discard: marker => calls.push(`discard:${marker}`) };
}

test('jobs.store.hold-port-brackets-write: clause 1: with a stub hold set through setWriteHold, a write through atomically() calls prepare, begin, then finish with released after COMMIT or rolled-back after ROLLBACK, in that order [C7]', t => {
  const db = database(t);
  const calls = [];
  setWriteHold(stubHold(calls));
  t.after(() => setWriteHold(null));
  atomically(db, () => { calls.push('work'); });
  assert.deepEqual(calls, ['prepare', 'begin:marker', 'work', 'finish:record:released']);
  calls.length = 0;
  assert.throws(() => atomically(db, () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(calls, ['prepare', 'begin:marker', 'finish:record:rolled-back']);
});

test('jobs.store.hold-port-skips-savepoint: clause 2: an atomically() call nested inside a caller transaction calls none of the hold functions [C7]', t => {
  const db = database(t);
  const calls = [];
  setWriteHold(stubHold(calls));
  t.after(() => setWriteHold(null));
  db.exec('BEGIN IMMEDIATE');
  atomically(db, () => { calls.push('work'); });
  db.exec('COMMIT');
  assert.deepEqual(calls, ['work']);
});

/** A real board file with the production job tables, its handle on busy_timeout 0, so only atomically's own wait counts. */
function heldBoard(t) {
  const file = cellRepo(t, { real: true }).boardFile;
  const db = cellBoard(t, file, undefined, { real: true }).db;
  db.exec('PRAGMA busy_timeout = 0');
  return { db, file };
}

test('jobs.store.busy-retries-then-succeeds: clause 1: with a second connection holding BEGIN IMMEDIATE and releasing it after 300 ms, atomically on a handle with busy_timeout 0 waits and runs its work, and the work commits [C7]', async t => {
  const { db, file } = heldBoard(t);
  await holdBoard(t, file, 300);
  const result = atomically(db, () => createJob(db, { id: 'gate:busy', kind: 'gate', now: 1 }).id);
  assert.equal(result, 'gate:busy');
  assert.equal(db.isTransaction, false);
  assert.equal(jobView(db, 'gate:busy').id, 'gate:busy', 'the work committed');
});

test('jobs.store.busy-surfaces-board-busy: clause 2: with the lock held past the bound, atomically throws Refused BOARD_BUSY, not a SQLITE error, and leaves the handle outside a transaction with its own busy_timeout restored [C7]', async t => {
  const { db, file } = heldBoard(t);
  db.exec('PRAGMA busy_timeout = 123');
  await holdBoard(t, file, 2500);
  const calls = [];
  setWriteHold(stubHold(calls));
  t.after(() => setWriteHold(null));
  assert.throws(() => atomically(db, () => 1, { boundMs: 300 }), refused('BOARD_BUSY'));
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 123);
  assert.deepEqual(calls, ['prepare', 'discard:marker'], 'the write hold stays paired');
});

test('jobs.store.offer-sequence-busy: clause 3: the createJob then writeStep sequence offerJob runs inside atomically, on the held database, throws BOARD_BUSY instead of ERR_SQLITE_ERROR [C7]', async t => {
  const { db, file } = heldBoard(t);
  await holdBoard(t, file, 2500);
  assert.throws(() => atomically(db, () => {
    createJob(db, { id: 'gate:offer', kind: 'gate', now: 1 });
    writeStep(db, 'gate:offer', 'offered', {}, { now: 2 });
  }, { boundMs: 300 }), refused('BOARD_BUSY'));
  assert.equal(jobView(db, 'gate:offer'), null, 'nothing was written');
});
