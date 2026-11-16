/** With runs_store on, the pulled-runner view, the stats readers and the sentinels job reader read the runs file read-only and write nothing to it; off, they read the board as on main [B2,#9014]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { createJob } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { readJobs } from '../../../sentinels/src/io/surfaces.js';
import { readDemandSpans } from '../../../stats/index.js';
import { readJobSpans } from '../../../stats/index.js';
import { readRunnerJobs } from '../../../stats/index.js';
import { readSeatActions } from '../../../stats/index.js';
import { openRunsStore } from '../../../store/index.js';
import { boardRunsReader } from '../../../store/index.js';
import { readPulledCapacity } from '../../index.js';

const NOW = 1_000_000;

/** Job rows for one serve: a claimed gate job held by r1, a queued test-run for seat-1 and a landing run held by a live-looking owner. */
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

/** Every reader's answer for a board handle and a runs option. */
function answers(db, runs, boardFile) {
  return {
    capacity: readPulledCapacity(db, { now: NOW, runs }),
    jobs: readRunnerJobs(db, { from: 0, until: NOW + 1, steps: ['claimed'], payloads: ['claimed'], runs }).map(job => [job.id, job.steps.map(step => step.name)]),
    demand: readDemandSpans(db, { since: 0, now: NOW, runs }).spans.map(span => [span.job, span.runner]),
    spans: readJobSpans(db, { since: 0, now: NOW, runs }).spans.map(span => [span.job, span.runner]),
    seats: readSeatActions(db, { from: 0, until: NOW, runs }).tests.map(test => test.seat),
    live: readJobs(boardFile, join(dirname(boardFile), 'no-such-spans'), NOW, new Map()).map(row => row.holder),
  };
}

/** A temp folder with a runs file seeded and closed, and a board file with the flag on. */
function fixture(t) {
  const dir = privateFixtureFiles('pullboard-runs-readers-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runsFile = join(dir, 'board.runs.sqlite');
  const runs = openRunsStore(runsFile, { boardId: 'b1' });
  seed(runs);
  runs.close();
  const boardFile = join(dir, 'board.sqlite');
  const db = board(boardFile, true);
  t.after(() => db.close());
  return { dir, runsFile, boardFile, db };
}

test('clause 1: with runs_store on, readPulledCapacity reads runner jobs from a read-only runs handle [B2,#9014]', t => {
  const { db, boardFile, runsFile } = fixture(t);
  const runs = boardRunsReader({ db }, boardFile);
  t.after(() => runs.db?.close());
  const capacity = readPulledCapacity(db, { now: NOW, runs });
  assert.deepEqual(capacity.serves.map(serve => [serve.runner, serve.claimed, serve.jobs]), [['lander:4242', 1, null], ['r1', 1, 4]]);
  assert.throws(() => runs.db.exec('CREATE TABLE x (y)'), /readonly/u);
  assert.deepEqual(readPulledCapacity(db, { now: NOW, runs: { db: null } }).totals, { claimed: 0, jobs: 0, serves: 0 }, 'a missing runs file reads as no jobs');
  assert.equal(runsFile.endsWith('board.runs.sqlite'), true);
});

test('clause 2: with runs_store on, the stats and sentinels job readers read the runs file read-only and write nothing to it [B2,#9014]', t => {
  const { db, boardFile, runsFile } = fixture(t);
  const digest = () => createHash('sha256').update(readFileSync(runsFile)).digest('hex');
  const before = digest();
  const runs = boardRunsReader({ db }, boardFile);
  t.after(() => runs.db?.close());
  const got = answers(db, runs, boardFile);
  assert.deepEqual(got.jobs.filter(row => row[1].length), [['gate:1', ['claimed']]]);
  assert.deepEqual(got.demand.map(row => row[0]).sort(), ['gate:1', 'land:1', 'run:1'].filter(job => got.demand.some(row => row[0] === job)));
  assert.ok(got.spans.some(row => row[0] === 'gate:1'));
  assert.deepEqual(got.seats, ['seat-1']);
  assert.equal(got.live.length, 1, 'the sentinels reader sees the landing run held in the runs file');
  assert.match(got.live[0], /land:1/u);
  assert.equal(digest(), before, 'no reader changed the runs file');
});

test('clause 3: with runs_store off, all of them read the board job rows as on main [B2,#9014]', t => {
  const dir = privateFixtureFiles('pullboard-runs-readers-off-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const boardFile = join(dir, 'board.sqlite');
  const db = board(boardFile, false);
  t.after(() => db.close());
  db.exec(`CREATE TABLE job (job_id TEXT PRIMARY KEY, job_kind TEXT, job_item INTEGER, job_candidate TEXT, job_base TEXT, job_step TEXT DEFAULT 'queued', job_attempt INTEGER DEFAULT 0, job_lease_owner TEXT, job_lease_until INTEGER DEFAULT 0, job_created INTEGER, job_updated INTEGER)`);
  const full = openRunsStore(':memory:', { boardId: 'b1' });
  t.after(() => full.close());
  seed(full);
  // The board holds the same rows as the flag-off layout: copy them across, table by table.
  const tables = ['job', 'job_step'];
  for (const table of tables) {
    const rows = full.prepare(`SELECT * FROM ${table}`).all();
    if (!rows.length) continue;
    if (table === 'job_step') db.exec(full.prepare("SELECT sql FROM sqlite_master WHERE name = 'job_step'").get().sql);
    for (const row of rows) {
      const keys = Object.keys(row);
      if (table === 'job') for (const key of keys) if (!db.prepare('PRAGMA table_info(job)').all().some(column => column.name === key)) db.exec(`ALTER TABLE job ADD COLUMN ${key} ${typeof row[key] === 'number' ? 'INTEGER' : 'TEXT'}`);
      db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
    }
  }
  const onMain = answers(db, null, boardFile);
  assert.deepEqual(answers(db, undefined, boardFile), onMain);
  assert.ok(onMain.capacity.serves.some(serve => serve.runner === 'r1' && serve.jobs === 4));
  assert.deepEqual(onMain.seats, ['seat-1']);
  assert.equal(boardRunsReader({ db }, boardFile), null, 'no runs reader is made while the flag is off');
});
