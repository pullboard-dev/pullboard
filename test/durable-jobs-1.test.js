/** Durable gate 1/20: the job and job_step tables, idempotent step writes and the job view [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { privateFixtureFiles } from './fixture-child.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { createJob, writeStep, jobView } from '../packages/jobs/index.js';

const files = privateFixtureFiles('pullboard-durable-jobs-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoard(name, body) {
  const board = openBoard(join(files.root, `${name}.sqlite`));
  try { return body(board.db); } finally { closeBoard(board); }
}

test('clause 1: the board opens with job and job_step tables whose step key is unique on (job, name, seq) [C7]', () => {
  withBoard('tables', (db) => {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('job','job_step') ORDER BY name").all().map(row => row.name);
    assert.deepEqual(names, ['job', 'job_step']);
    createJob(db, { id: 'j1', kind: 'gate', now: 1 });
    db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_at) VALUES ('j1', 's', 0, 1)").run();
    assert.throws(() => db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_at) VALUES ('j1', 's', 0, 2)").run(), /UNIQUE/u);
  });
});

test('clause 2: writeStep is a no-op on a repeat and returns the stored payload [C7]', () => {
  withBoard('repeat', (db) => {
    createJob(db, { id: 'j2', kind: 'gate', item: 7, now: 1 });
    assert.deepEqual(writeStep(db, 'j2', 'captured', { tree: 'aaa' }, { now: 2 }), { written: true, payload: { tree: 'aaa' } });
    assert.deepEqual(writeStep(db, 'j2', 'captured', { tree: 'bbb' }, { now: 3 }), { written: false, payload: { tree: 'aaa' } });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_step').get().n, 1);
    assert.deepEqual(writeStep(db, 'j2', 'shard.done', { shard: 1 }, { seq: 1, now: 4 }).written, true);
    assert.deepEqual(writeStep(db, 'j2', 'shard.done', { shard: 2 }, { seq: 2, now: 5 }).written, true);
    assert.throws(() => writeStep(db, 'nope', 'captured'), { code: 'JOB_MISSING' });
  });
});

test('clause 3: jobView returns the current step, the last one written [C7]', () => {
  withBoard('view', (db) => {
    assert.equal(jobView(db, 'absent'), null);
    createJob(db, { id: 'j3', kind: 'gate', item: 9, candidate: 'c1', base: 'b1', now: 1 });
    assert.equal(jobView(db, 'j3').step, 'queued');
    writeStep(db, 'j3', 'captured', { tree: 't' }, { now: 2 });
    writeStep(db, 'j3', 'running', { runner: 'r1' }, { now: 3 });
    writeStep(db, 'j3', 'captured', {}, { now: 4 });
    const view = jobView(db, 'j3');
    assert.equal(view.step, 'running');
    assert.deepEqual(view.steps.map(step => step.name), ['captured', 'running']);
    assert.equal(view.item, 9);
    assert.equal(view.updated, 3);
    assert.equal(createJob(db, { id: 'j3', kind: 'gate' }).step, 'running');
  });
});
