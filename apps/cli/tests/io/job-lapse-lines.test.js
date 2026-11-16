/** @pullboard-test-input source-cell apps/cli */
/** pullboard trace prints each lapsed job step as one line with its runner, attempt, lease end and last step [C7,#9248]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createJob } from '../../../../packages/jobs/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import { JOB_SCHEMA_SQL } from '../../../../packages/store/index.js';
import { readJobSteps } from '../../src/io/trace.js';
import { traceLine } from '../../src/io/trace.js';
import { traceTimeline } from '../../src/io/trace.js';

const NOW = Date.UTC(2026, 10, 16, 15, 0, 0);

/** A board with one gate job for item 7 that was offered and taken by runner-a. */
function board() {
  const db = new DatabaseSync(':memory:');
  db.exec(JOB_SCHEMA_SQL);
  db.exec('CREATE TABLE IF NOT EXISTS item (item_id INTEGER PRIMARY KEY, item_status TEXT)');
  createJob(db, { id: 'gate:7', kind: 'gate', item: 7, now: NOW });
  writeStep(db, 'gate:7', 'offered', {}, { now: NOW + 1 });
  takeJob(db, 'gate:7', 'runner-a', { now: NOW + 10 });
  return db;
}

/** The trace lines of item 7, as the command prints them. */
const lines = db => traceTimeline({ lines: [], events: [], subject: '7', jobs: readJobSteps(db) }).map(traceLine);

test('clause 1: a lapsed step prints as one line with the runner, attempt, lease end and last step [C7,#9248]', () => {
  const db = board();
  const lease = NOW + 120_000, last = NOW + 90_000;
  writeStep(db, 'gate:7', 'lapsed', { runner: 'runner-a', attempt: 1, leaseUntil: lease, lastAt: last, lastStep: 'offered' }, { now: NOW + 130_000 });
  const lapsed = lines(db).filter(line => line.includes('gate:lapsed'));
  assert.equal(lapsed.length, 1, 'one line for the one lapsed step');
  for (const part of ['runner runner-a', 'attempt 1', `lease ended ${new Date(lease).toISOString()}`, `last step offered at ${new Date(last).toISOString()}`]) {
    assert.ok(lapsed[0].includes(part), `the line names ${part}: ${lapsed[0]}`);
  }
  assert.ok(!lapsed[0].includes('{'), 'no raw JSON');
});

test('clause 2: a job with no lapsed step prints exactly what it printed before [C7,#9248]', () => {
  const db = board();
  writeStep(db, 'gate:7', 'running', { note: 'ok' }, { now: NOW + 20 });
  const text = lines(db).join('\n');
  assert.ok(!text.includes('lapsed'), 'no lapse wording on a job that never lapsed');
  assert.match(text, /gate:running .*job gate:7 attempt 1 \{"note":"ok"\}/u, 'a step prints its job, attempt and payload as before');
});
