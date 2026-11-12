/** Durable gate 14/20: `next` and `status` run one fallback reclaim pass and drive at most one lapsed job [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  openBoard,
  closeBoard,
} from '../../../lib/index.js';
import {
  createJob,
  jobView,
  takeJob,
  writeStep,
  LEASE_MS,
} from '../../../../packages/jobs/index.js';
import {
  DISPATCHER_JOB,
  reclaimPass,
} from '../../../../packages/drive/index.js';

const files = privateFixtureFiles('pullboard-durable-drive14-');
const e2e = createE2eHelpers();
const repos = [];
after(() => { for (const root of [files.root, ...repos]) rmSync(root, { recursive: true, force: true }); e2e.cleanup(); });

/** A real repository with one commit, returning its path and head. */
function repoWithCommit() {
  const tree = privateFixtureFiles('pullboard-drive14-repo-');
  const repo = tree.root;
  repos.push(repo);
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'drive@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Drive Test']);
  tree.write('tool.txt', 'tooling\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'seed']);
  return { repo, head: runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']) };
}

/** Create a queued gate job that a dead driver took at `takenAt`, so its lease lapses 2 minutes later. */
function lapsedJob(db, id, candidate, takenAt) {
  createJob(db, { id, kind: 'gate', candidate, base: candidate, now: takenAt });
  assert.equal(takeJob(db, id, 'dead-driver', { now: takenAt }).taken, true);
}

test('clause 1: one reclaim pass drives at most one lapsed job by one transition and never waits past its budget [C7]', async () => {
  const { repo, head } = repoWithCommit();
  const board = openBoard(':memory:');
  try {
    const db = board.db;
    let calls = 0;
    const counting = async (...args) => { calls += 1; return { transition: null, phase: 'queued', job: jobView(db, args[1]) }; };
    assert.deepEqual(await reclaimPass(db, { owner: 'cmd', drive: counting, now: () => 1000 }), { lapsed: 0, driven: null });
    assert.equal(calls, 0, 'a board with no lapsed job drives nothing');

    lapsedJob(db, 'g-old', head, 10_000);
    lapsedJob(db, 'g-new', head, 20_000);
    createJob(db, { id: DISPATCHER_JOB, kind: 'dispatcher', now: 5 });
    assert.equal(takeJob(db, DISPATCHER_JOB, 'dead-loop', { now: 5 }).taken, true);
    lapsedJob(db, 'g-done', head, 5);
    writeStep(db, 'g-done', 'verdict', {}, { now: 6 });
    const at = 20_000 + LEASE_MS + 1;
    const pass = await reclaimPass(db, { owner: 'cmd', repo, now: () => at });
    assert.deepEqual(pass, { lapsed: 2, driven: 'g-old', transition: 'captured', phase: 'captured' },
      'the oldest lapsed gate job moves one step; the dispatcher row and a job at its verdict are never driven');
    assert.equal(jobView(db, 'g-old').leaseOwner, 'cmd', 'the pass took the lapsed lease');
    assert.deepEqual(jobView(db, 'g-new').steps, [], 'at most one job is driven per pass');
    assert.equal(jobView(db, 'g-new').leaseOwner, 'dead-driver');

    // A drive that never settles: the pass answering at all proves it never waits on the job.
    const hanging = () => new Promise(() => {});
    const waited = await reclaimPass(db, { owner: 'cmd', drive: hanging, budgetMs: 50, now: () => at });
    assert.deepEqual(waited, { lapsed: 1, driven: 'g-new', pending: true }, 'a drive past the budget leaves the command free to answer');

    const refused = await reclaimPass(db, { owner: 'cmd', drive: () => { throw new Error('runner gone'); }, now: () => at });
    assert.deepEqual(refused, { lapsed: 1, driven: 'g-new', code: 'DRIVE_FAILED' }, 'a failed drive never fails the command');
  } finally { closeBoard(board); }
});

test('clause 1: `status` and `next` each run the reclaim pass and drive at most one lapsed job before answering [C7]', () => {
  const box = e2e.project();
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  const file = join(box.repo, '.git/pullboard/board.sqlite');
  const takenAt = Date.now() - LEASE_MS - 60_000;
  // @pullboard-board-file journey: seed and read back the lapsed job rows in the board file the real status command opens
  const seed = openBoard(file, undefined, { gitRoot: box.repo });
  try {
    lapsedJob(seed.db, 'g-old', head, takenAt);
    lapsedJob(seed.db, 'g-new', head, takenAt + 1);
  } finally { closeBoard(seed); }

  // A preload counts every reclaimLapsed query (its one SELECT; takeJob's UPDATE is not counted) in each command's process.
  const countFile = join(files.root, 'reclaim-count.log');
  files.write('count-reclaim.mjs', [
    "import { DatabaseSync } from 'node:sqlite';",
    "import { appendFileSync } from 'node:fs';",
    'const prepare = DatabaseSync.prototype.prepare;',
    'DatabaseSync.prototype.prepare = function (sql, ...rest) {',
    "  if (/^SELECT job_id, job_kind.*job_lease_until < \\?/.test(String(sql))) appendFileSync(process.env.RECLAIM_COUNT_FILE, 'x');",
    '  return prepare.call(this, sql, ...rest);',
    '};', ''].join('\n'));
  const preload = join(files.root, 'count-reclaim.mjs');
  box.env.RECLAIM_COUNT_FILE = countFile;
  box.env.NODE_OPTIONS = `--import ${preload}`;
  const reclaimQueries = () => { try { return readFileSync(countFile, 'utf8').length; } catch { return 0; } };

  const status = box.run(box.repo, 'status', '--json');
  assert.equal(reclaimQueries(), 1, 'status ran reclaimLapsed exactly once');
  assert.equal(status.code, 0, status.err);
  assert.deepEqual(JSON.parse(status.out).reclaim, { lapsed: 2, driven: 'g-old', transition: 'captured', phase: 'captured' },
    'status drove the oldest lapsed job one step before answering');

  const read = (id) => {
    // @pullboard-board-file journey: seed and read back the lapsed job rows in the board file the real status command opens
    const board = openBoard(file, undefined, { gitRoot: box.repo });
    try { return jobView(board.db, id); } finally { closeBoard(board); }
  };
  assert.match(read('g-old').leaseOwner, /^fallback:status:/);
  assert.deepEqual(read('g-new').steps, [], 'status drove at most one job');

  rmSync(countFile, { force: true });
  box.run(box.web, 'next');
  assert.equal(reclaimQueries(), 1, 'next ran reclaimLapsed exactly once');
  const driven = read('g-new');
  assert.equal(driven.steps.at(-1)?.name, 'captured', 'next drove the other lapsed job one step');
  assert.match(driven.leaseOwner, /^fallback:next:/);
  assert.equal(read('g-old').steps.length, 1, 'next left the job status still holds alone');
});
