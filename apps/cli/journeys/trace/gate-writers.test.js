/** A gate job writes lease grant, renew, release and end-reason notes that the trace shows and the step readers skip [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createJob } from '../../../../packages/jobs/index.js';
import { endJob } from '../../../../packages/jobs/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { releaseLease } from '../../../../packages/jobs/index.js';
import { renewLease } from '../../../../packages/jobs/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import { unaccountedRedFindings } from '../../../../packages/health/index.js';
import { handoffRecords } from '../../../../packages/store/index.js';
import { JOB_SCHEMA_SQL } from '../../../../packages/store/index.js';
import { readJobSteps } from '../../src/io/trace.js';
import { traceLine } from '../../src/io/trace.js';
import { traceTimeline } from '../../src/io/trace.js';

const UNNAMED = 'the submission proof is red at 0123456789ab; fix it, commit, submit again. 2 failed\nrun-tests: phases 1.2s\nknown-main acceptance unavailable: the proof has no complete named failure diagnostics';
const NOW = Date.UTC(2026, 10, 8, 18, 0, 0);

/** A board with one gate job for item 7 that was taken, renewed, released, taken again and ended, then wrote its red record last. */
function gateJob() {
  const db = new DatabaseSync(':memory:');
  db.exec(JOB_SCHEMA_SQL);
  db.exec('CREATE TABLE IF NOT EXISTS item (item_id INTEGER PRIMARY KEY, item_status TEXT)');
  createJob(db, { id: 'gate:7', kind: 'gate', item: 7, now: NOW });
  writeStep(db, 'gate:7', 'offered', {}, { now: NOW + 1 });
  takeJob(db, 'gate:7', 'runner-a', { now: NOW + 10 });
  renewLease(db, 'gate:7', 'runner-a', { now: NOW + 20 });
  releaseLease(db, 'gate:7', 'runner-a', { now: NOW + 30 });
  takeJob(db, 'gate:7', 'runner-b', { now: NOW + 40 });
  return db;
}

test('clause 1: a gate job lease grant, renew, release and end-reason notes appear in pullboard trace output [C7]', () => {
  const db = gateJob();
  endJob(db, 'gate:7', 'withdrawn', { detail: 'the item was withdrawn' }, { now: NOW + 50 });
  const entries = traceTimeline({ lines: [], events: [], subject: '7', jobs: readJobSteps(db) });
  const text = entries.map(traceLine).join('\n');
  for (const note of ['note:lease.grant', 'note:lease.renew', 'note:lease.release', 'note:end.withdrawn']) assert.match(text, new RegExp(note.replace('.', '\\.'), 'u'), `${note} is in the trace`);
  assert.match(text, /runner-a/u, 'the note names the runner that held the lease');
  assert.match(text, /the item was withdrawn/u, 'the end note names why the job ended');
});

test('a job of another kind writes no lease notes [C7]', () => {
  const db = gateJob();
  createJob(db, { id: 'land:1', kind: 'land', item: 8, now: NOW });
  takeJob(db, 'land:1', 'runner-a', { now: NOW + 5 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = 'land:1'").get().n, 0);
});

test('clause 2: viewOf, the health detector and the store handoff readers skip lease notes when they pick the current job_step [C7]', () => {
  const db = gateJob();
  const record = { id: 'gate:7', state: 'red', completedAt: new Date(NOW).toISOString(), error: { code: 'GATE_RED', message: UNNAMED, next: 'fix' } };
  writeStep(db, 'gate:7', 'red', { record }, { now: NOW + 45 });
  // A job whose lease was granted after its record step has a note as its newest row.
  createJob(db, { id: 'gate:9', kind: 'gate', item: 9, now: NOW });
  writeStep(db, 'gate:9', 'offered', {}, { now: NOW + 1 });
  takeJob(db, 'gate:9', 'runner-c', { now: NOW + 2 });
  const lastNote = db.prepare("SELECT job_step_name AS name FROM job_step WHERE job_step_job = 'gate:9' ORDER BY job_step_id DESC LIMIT 1").get().name;
  assert.match(lastNote, /^note:/u, 'the newest row is a note');
  assert.equal(jobView(db, 'gate:9').step, 'offered', 'viewOf reads the step the job kept, not the lease note');
  assert.equal(jobView(db, 'gate:7').step, 'red');
  assert.deepEqual(handoffRecords(db).get(7), record, 'the handoff reader finds the record behind the notes');
  for (const n of [101, 102]) {
    createJob(db, { id: `gate:${n}`, kind: 'gate', item: n, now: NOW });
    writeStep(db, `gate:${n}`, 'red', { record: { ...record, id: `gate:${n}` } }, { now: NOW + 45 });
    takeJob(db, `gate:${n}`, 'runner-c', { now: NOW + 46 });
  }
  assert.equal(handoffRecords(db).get(101)?.state, 'red', 'the handoff reader finds a record behind a newer note');
  assert.equal(unaccountedRedFindings(db, new Date(NOW + 60_000))[0].subject, '3 of 3 red gates', 'all three reds are read although a note is each new job newest row');
});
