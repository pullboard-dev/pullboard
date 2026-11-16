/** With runs_store on, the stats job readers read the runs file read-only and write nothing to it; off, they read the board as on main [B2,#9014]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { createJob } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { readDemandSpans } from '../../index.js';
import { readJobSpans } from '../../index.js';
import { readRunnerJobs } from '../../index.js';
import { readSeatActions } from '../../index.js';

const NOW = 1_000_000;

/** The job tables a board or a runs file holds, as the jobs cell reads and writes them. */
const JOB_SCHEMA_SQL = `
  CREATE TABLE job (job_id TEXT PRIMARY KEY, job_kind TEXT NOT NULL, job_item INTEGER, job_candidate TEXT, job_base TEXT, job_step TEXT NOT NULL DEFAULT 'queued',
    job_attempt INTEGER NOT NULL DEFAULT 0, job_lease_owner TEXT, job_lease_until INTEGER NOT NULL DEFAULT 0, job_created INTEGER NOT NULL, job_updated INTEGER NOT NULL);
  CREATE TABLE job_step (job_step_id INTEGER PRIMARY KEY AUTOINCREMENT, job_step_job TEXT NOT NULL, job_step_name TEXT NOT NULL, job_step_seq INTEGER NOT NULL DEFAULT 0,
    job_step_payload TEXT NOT NULL DEFAULT '{}', job_step_at INTEGER NOT NULL, UNIQUE (job_step_job, job_step_name, job_step_seq));`;

/** Job rows: a gate job held by r1 (declared 4 jobs), a queued test-run for seat-1 and a landing run held by a live-looking owner. */
function seed(db) {
  createJob(db, { id: 'gate:1', kind: 'gate', item: 1, now: NOW - 5000 });
  writeStep(db, 'gate:1', 'claimed', { runner: 'r1', jobs: 4, cores: 8, ram: 100 }, { now: NOW - 4000 });
  takeJob(db, 'gate:1', 'r1', { now: NOW - 3000 });
  createJob(db, { id: 'run:1', kind: 'test-run', now: NOW - 2000 });
  writeStep(db, 'run:1', 'queued', { agent: 'seat-1' }, { now: NOW - 1500 });
  createJob(db, { id: 'land:1', kind: 'landing-run', item: 2, now: NOW - 1000 });
  takeJob(db, 'land:1', 'lander:4242', { now: NOW - 500 });
}

/** A board file stand-in (board_meta and event only, so any wrong read of a job table throws), the flag as asked. */
function board(file, flag) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL); CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_by TEXT, event_at TEXT)');
  if (flag) db.prepare("INSERT INTO board_meta VALUES ('runs_store', '1')").run();
  return db;
}

/** A private folder with a runs file seeded and closed, and a board file with the flag on. */
function fixture(t) {
  const box = privateFixtureFiles('pullboard-runs-readers-');
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const runsFile = join(box.root, 'board.runs.sqlite');
  const runs = new DatabaseSync(runsFile);
  runs.exec(JOB_SCHEMA_SQL);
  seed(runs);
  runs.close();
  const boardFile = join(box.root, 'board.sqlite');
  const db = board(boardFile, true);
  t.after(() => db.close());
  return { dir: box.root, runsFile, boardFile, db };
}

/** The flag-off layout: the same rows on the board itself, in a private folder. */
function offFixture(t) {
  const box = privateFixtureFiles('pullboard-runs-readers-off-');
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const boardFile = join(box.root, 'board.sqlite');
  const db = board(boardFile, false);
  t.after(() => db.close());
  const full = new DatabaseSync(':memory:');
  full.exec(JOB_SCHEMA_SQL);
  seed(full);
  db.exec(full.prepare("SELECT group_concat(sql, ';') AS sql FROM sqlite_master WHERE type = 'table' AND name IN ('job', 'job_step')").get().sql);
  for (const table of ['job', 'job_step']) {
    for (const row of full.prepare(`SELECT * FROM ${table}`).all()) {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
    }
  }
  full.close();
  return { boardFile, db };
}

/** Every stats reader's answer for a board handle and a runs option. */
function answers(db, runs) {
  return {
    jobs: readRunnerJobs(db, { from: 0, until: NOW + 1, steps: ['claimed'], payloads: ['claimed'], runs }).map(job => [job.id, job.steps.map(step => step.name)]),
    demand: readDemandSpans(db, { since: 0, now: NOW, runs }).spans.map(span => [span.job, span.runner]),
    spans: readJobSpans(db, { since: 0, now: NOW, runs }).spans.map(span => [span.job, span.runner]),
    seats: readSeatActions(db, { from: 0, until: NOW, runs }).tests.map(row => row.seat),
  };
}

test('clause 2: with runs_store on, the stats job readers read the runs file read-only and write nothing to it [B2,#9014]', t => {
  const { db, runsFile } = fixture(t);
  const digest = () => createHash('sha256').update(readFileSync(runsFile)).digest('hex');
  const before = digest();
  const runs = { db: new DatabaseSync(runsFile, { readOnly: true }) };
  t.after(() => runs.db?.close());
  const got = answers(db, runs);
  assert.deepEqual(got.jobs.filter(row => row[1].length), [['gate:1', ['claimed']]]);
  assert.ok(got.demand.some(row => row[0] === 'gate:1'));
  assert.ok(got.spans.some(row => row[0] === 'gate:1'));
  assert.deepEqual(got.seats, ['seat-1']);
  assert.deepEqual(answers(db, { db: null }), { jobs: [], demand: [], spans: [], seats: [] }, 'a missing runs file reads as no jobs');
  assert.equal(digest(), before, 'no reader changed the runs file');
});

test('clause 3: with runs_store off, the stats job readers read the board job rows as on main [B2,#9014]', t => {
  const { db } = offFixture(t);
  const onMain = answers(db, null);
  assert.deepEqual(answers(db, undefined), onMain);
  assert.deepEqual(onMain.seats, ['seat-1']);
  assert.ok(onMain.spans.some(row => row[0] === 'gate:1'));
});
