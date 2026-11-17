/** @pullboard-test-input source-cell sentinels */
/** With runs_store on, the sentinels job reader reads the runs file read-only and writes nothing to it; off, it reads the board as on main [B2,#9014]. */
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
import { openRunsStore } from '../../../store/index.js';
import { boardRunsReader } from '../../../store/index.js';
import { readJobs } from '../../src/io/surfaces.js';

const NOW = 1_000_000;

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
  const runs = openRunsStore(runsFile, { boardId: 'b1' });
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
  const full = openRunsStore(':memory:', { boardId: 'b1' });
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

test('clause 2: with runs_store on, the sentinels job reader reads the runs file read-only and writes nothing to it [B2,#9014]', t => {
  const { dir, boardFile, runsFile } = fixture(t);
  const digest = () => createHash('sha256').update(readFileSync(runsFile)).digest('hex');
  const before = digest();
  const live = readJobs(boardFile, join(dir, 'no-such-spans'), NOW, new Map()).map(row => row.holder);
  assert.equal(live.length, 2, 'the held gate and the landing run, both read from the runs file');
  assert.ok(live.some(holder => /land:1/u.test(holder)));
  assert.equal(digest(), before, 'the reader changed nothing in the runs file');
});

test('clause 3: with runs_store off, the sentinels job reader reads the board job rows as on main [B2,#9014]', t => {
  const { boardFile } = offFixture(t);
  const live = readJobs(boardFile, join(dirname(boardFile), 'no-such-spans'), NOW, new Map()).map(row => row.holder);
  assert.equal(live.length, 2);
  assert.ok(live.some(holder => /land:1/u.test(holder)));
});
