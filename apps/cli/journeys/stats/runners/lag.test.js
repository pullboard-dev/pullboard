/** Main check lag from seeded landings and main-test results, with exact lags [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  createJob,
  writeStep,
} from '../../../../../packages/jobs/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureOpenBoard } from '../../../tests/fixtures/testkit.js';

/** ISO time on the seeded day. */
const iso = (time) => `2026-10-12T${time}Z`;
const STRANGER = 'f'.repeat(40);

/** Git in a folder, trimmed. */
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** Seed the known jobs, steps and events for the four seeded main commits. */
function seed(db, main) {
  /** A commit landing on main. */
  const landed = (sha, at) => db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)')
    .run(at, 'coordinator', 'main-moved', null, JSON.stringify({ sha, batch: 'seed', items: [] }));
  /** One file of the full suite, run on a main tree and recorded as a receipt. */
  const result = (tree, file, at, verdict) => {
    const id = `main-test:${tree}:${file}`;
    createJob(db, { id, kind: 'main-test', base: tree, now: Date.parse(iso('00:00:00.000')) });
    writeStep(db, id, 'queued', { tree, file, command: 'node --test' }, { now: Date.parse(iso('00:00:00.000')) });
    writeStep(db, id, 'receipt', { id, tree, file, command: 'node --test', verdict, failing: [], main: null, at: Date.parse(iso(at)) }, { seq: 0, now: Date.parse(iso(at)) });
  };
  landed(main.OLD.sha, '2026-10-11T08:00:00.000Z');
  landed(main.A.sha, iso('10:00:00.000'));
  landed(main.B.sha, iso('10:30:00.000'));
  landed(main.C.sha, iso('11:00:00.000'));
  landed(main.D.sha, iso('11:30:00.000'));
  result(main.A.tree, 'one.test.js', '10:04:00.000', 'green');
  result(main.A.tree, 'two.test.js', '10:09:00.000', 'red');
  result(main.A.tree, 'three.test.js', '10:03:00.000', 'green');
  result(main.B.tree, 'one.test.js', '10:31:30.000', 'red');
  result(main.D.tree, 'one.test.js', '11:50:00.000', 'green');
  result(STRANGER, 'one.test.js', '10:00:30.000', 'red');
}

/** Make a commit with its own tree on top of the repo's history, returning the commit and tree ids. */
function addCommit(repo, name) {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: `${name}\n`, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['mktree'], { cwd: repo, input: `100644 blob ${blob}\t${name}\n`, encoding: 'utf8' }).trim();
  return { sha: git(repo, 'commit-tree', tree, '-m', name), tree };
}

/** A project whose board holds the seeded rows; the board is closed again before the CLI reads it. */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const main = Object.fromEntries(['OLD', 'A', 'B', 'C', 'D'].map(name => [name, addCommit(box.repo, `${name}.txt`)]));
  const board = fixtureOpenBoard({ boardFile: join(box.repo, '.git', 'pullboard', 'board.sqlite'), web: box.repo });
  try { seed(board.db, main); } finally { store.closeBoard(board); }
  return { box, main };
}

/** Run one real CLI invocation in the project and return its code and output. */
function command(box, args) {
  return box.runLocal(box.web, ...args);
}

test('runners lag: seeded landings and results give exact lags and red lags [C7]', async t => {
  const { box, main } = fixture(t);
  const result = await command(box, ['stats', 'runners', '--lag', '--window', '24h', '--until', '2026-10-12T12:00:00Z', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const lag = JSON.parse(result.stdout).runners.mainLag;
  assert.deepEqual(lag.commits, [
    { sha: main.A.sha, landedAt: iso('10:00:00.000'), firstResultAt: iso('10:03:00.000'), lagMs: 180000, firstResult: 'green', firstRedAt: iso('10:09:00.000'), redLagMs: 540000 },
    { sha: main.B.sha, landedAt: iso('10:30:00.000'), firstResultAt: iso('10:31:30.000'), lagMs: 90000, firstResult: 'red', firstRedAt: iso('10:31:30.000'), redLagMs: 90000 },
    { sha: main.C.sha, landedAt: iso('11:00:00.000'), firstResultAt: null, lagMs: null, firstResult: null, firstRedAt: null, redLagMs: null },
    { sha: main.D.sha, landedAt: iso('11:30:00.000'), firstResultAt: iso('11:50:00.000'), lagMs: 1200000, firstResult: 'green', firstRedAt: null, redLagMs: null },
  ]);
  assert.deepEqual(lag.summary, { landed: 4, measured: 3, pending: 1, p50Ms: 180000, p90Ms: 1200000, maxMs: 1200000, reds: 2, redP50Ms: 90000, redMaxMs: 540000 });
});

test('runners lag: text names each commit, --main-lag is the same view, and a bare stats runners stays the wait view [C7]', async t => {
  const { box, main } = fixture(t);
  const text = await command(box, ['stats', 'runners', '--main-lag', '--until', '2026-10-12T12:00:00Z']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /main check lag: 4 landed, 3 with a result, 1 pending/u);
  assert.match(text.stdout, new RegExp(`${main.B.sha.slice(0, 10)} landed 2026-10-12T10:30:00\\.000Z: result after 90\\.0s, red recorded after 90\\.0s`, 'u'));
  const waits = await command(box, ['stats', 'runners', '--json']);
  assert.equal(waits.code, 0, waits.stderr);
  assert.ok(JSON.parse(waits.stdout).runners.waits);
});
