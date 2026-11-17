/** Job steps of items finished over 30 days ago move to a gzip archive beside the board and stay readable [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { createJob } from '../../../../../jobs/index.js';
import { writeStep } from '../../../../../jobs/index.js';
import { jobView } from '../../../../../jobs/index.js';
import { compactJobSteps } from '../../../../../store/index.js';
import { jobHistory } from '../../../../../store/index.js';
import { stepArchivePath } from '../../../../../store/index.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-13T12:00:00Z');

/** A board on a real file with the job tables a writable open installs. */
function boardOf(t) {
  const { boardFile } = cellProject(t, { real: true });
  const board = cellBoard(t, boardFile, undefined, { real: true });
  return { board, db: board.db, file: boardFile };
}

/** Run `work` with the board file's machine guards dropped, then put back exactly the SQL they had; the fixture files items no move reached. */
function unguarded(db, work) {
  const guards = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine%'").all();
  for (const { name } of guards) db.exec(`DROP TRIGGER "${name}"`);
  try { work(); } finally { for (const { sql } of guards) db.exec(sql); }
}

/** File an item in the given state, finished `age` days before NOW; landed ones get a merged event, withdrawn ones a withdraw event. */
function itemOf(db, id, status, age) {
  const at = new Date(NOW - age * DAY).toISOString();
  db.prepare('INSERT INTO item (item_id, item_lane, item_title, item_status, item_created_by, item_created_at, item_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'web', `item ${id}`, status === 'landed' ? 'verified' : status, 'coordinator', at, at);
  if (status === 'landed' || status === 'withdrawn') {
    db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)')
      .run(at, 'coordinator', status === 'landed' ? 'merged' : 'withdraw', id, '{}');
  }
}

/** A gate job for the item with an offer, progress and phase steps of about 16 KB each, a receipt and a done step. */
function jobOf(db, item) {
  const id = `gate:${item}`;
  createJob(db, { id, kind: 'gate', item, candidate: `c${item}`, now: NOW - 40 * DAY });
  const log = (name, payload, seq = 0) => writeStep(db, id, name, payload, { seq, now: NOW - 40 * DAY });
  log('offered', { request: { submit: { item } } });
  for (let n = 1; n <= 5; n += 1) log('phase', { n, output: `${item}:${n}`.padEnd(16_000, 'x') }, n);
  log('receipt', { runner: 'r1', ok: true });
  log('record', { record: { id, state: 'green' } });
  log('done', { ok: true });
  return id;
}

/** Every row of a table as one comparable text. */
function rowsOf(db, table) {
  return JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

/** A board with old landed and withdrawn items, a recent landed one and an open one, each with a gate job. */
function seeded(t) {
  const { db, file } = boardOf(t);
  unguarded(db, () => {
    itemOf(db, 101, 'landed', 45);
    itemOf(db, 102, 'withdrawn', 31);
    itemOf(db, 103, 'landed', 5);
    itemOf(db, 104, 'open', 90);
  });
  const jobs = Object.fromEntries([101, 102, 103, 104].map(item => [item, jobOf(db, item)]));
  return { db, file, jobs };
}

test('clause 1: compaction moves old finished items\' job steps to a gzip beside the board, keeps each job\'s last step, and leaves item and event rows alone [C7]', (t) => {
  const { db, file, jobs } = seeded(t);
  const items = rowsOf(db, 'item'), events = rowsOf(db, 'event');
  const before = jobView(db, jobs[101]);
  const report = compactJobSteps(db, { now: NOW });
  assert.equal(report.jobs, 2);
  assert.equal(report.rows, 2 * 5, 'the five phase steps of each old job');
  assert.equal(rowsOf(db, 'item'), items);
  assert.equal(rowsOf(db, 'event'), events);
  const after = jobView(db, jobs[101]);
  assert.equal(after.step, 'done');
  assert.deepEqual(after.steps.map(step => step.name), ['offered', 'receipt', 'record', 'done'], 'the offer, receipt, hand-off record and last step stay');
  assert.deepEqual(after.steps.at(-1), before.steps.at(-1));
  assert.equal(jobView(db, jobs[103]).steps.length, before.steps.length, 'a recently landed item keeps every step');
  assert.equal(jobView(db, jobs[104]).steps.length, before.steps.length, 'an open item keeps every step');
  const archive = stepArchivePath(file);
  assert.ok(existsSync(archive));
  const lines = gunzipSync(readFileSync(archive)).toString('utf8').trim().split('\n');
  assert.equal(lines.length, 10);
  assert.ok(lines.every(line => JSON.parse(line).name === 'phase'));
});

test('clause 1: board.sqlite shrinks after VACUUM and the report says by how much [C7]', (t) => {
  const { db, file } = seeded(t);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const big = statSync(file).size;
  const report = compactJobSteps(db, { now: NOW });
  assert.equal(report.vacuumed, true);
  assert.ok(report.after < report.before, `${report.after} < ${report.before}`);
  assert.ok(statSync(file).size < big, `${statSync(file).size} < ${big}`);
  assert.ok(report.archiveBytes > 0 && report.archiveBytes < report.payloadBytes, 'the archive is gzipped');
});

test('clause 1: history reads return the archived steps in their places, and a second pass finds nothing more to move [C7]', (t) => {
  const { db, jobs } = seeded(t);
  const before = jobView(db, jobs[102]);
  compactJobSteps(db, { now: NOW });
  const history = jobHistory(db, jobs[102]);
  assert.deepEqual(history.steps, before.steps, 'every step is back, oldest first');
  assert.equal(history.step, before.step);
  assert.deepEqual(jobHistory(db, jobs[103]), jobView(db, jobs[103]), 'a job with nothing archived reads as it always did');
  assert.equal(jobHistory(db, 'gate:none'), null);
  const again = compactJobSteps(db, { now: NOW });
  assert.equal(again.rows, 0);
  assert.equal(jobHistory(db, jobs[101]).steps.length, 9);
});

test('clause 1: a dry run reports the rows it would move and changes nothing [C7]', (t) => {
  const { db, file, jobs } = seeded(t);
  const before = rowsOf(db, 'job_step');
  const report = compactJobSteps(db, { now: NOW, dryRun: true });
  assert.equal(report.rows, 10);
  assert.equal(report.dryRun, true);
  assert.equal(rowsOf(db, 'job_step'), before);
  assert.equal(existsSync(stepArchivePath(file)), false);
  assert.equal(jobView(db, jobs[101]).steps.length, 9);
});

test('clause 1: a job whose lease is live is never compacted [C7]', (t) => {
  const { db, jobs } = seeded(t);
  db.prepare('UPDATE job SET job_lease_owner = ?, job_lease_until = ? WHERE job_id = ?').run('runner', NOW + DAY, jobs[101]);
  assert.equal(compactJobSteps(db, { now: NOW }).rows, 5);
  assert.equal(jobView(db, jobs[101]).steps.length, 9);
});
