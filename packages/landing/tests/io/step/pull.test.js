/** @pullboard-test-input packages/landing/src/io/step/pull.js packages/store/src/io/board/pulled.js */
/** The pull-out job reverts a pulling item's landed merge, pushes it through the hop fence and records the item pulled; a conflict blocks the job [M2,R3,#9099]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../../gate/tests/fixtures/child.js';
import { gateHopMove } from '../../../../store/index.js';
import * as store from '../../../../store/index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { hopFenceObject } from '../../../src/io/land/fence.js';
import { hopFenceRef } from '../../../src/io/land/fence.js';
import { fenceHop } from '../../../src/io/step/publish.js';
import { pushTrunkThroughFence } from '../../../src/io/step/publish.js';
import { runPullOutJob } from '../../../src/io/step/pull.js';

/** The lander's fenced push, passed in as publish.js's own functions. */
const PUSH = { fenceHop, pushTrunkThroughFence };

const TRUNK = 'refs/heads/main';
const AT = Date.parse('2026-11-16T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();

/** A real repository on main with its own identity, a bare remote cloned from it, and a git runner for each. */
function trunkRepo(t) {
  const repo = cellRepo(t, { real: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => runFixtureSetupGit(args, { cwd: repo.root, env });
  git('config', 'user.name', 'Lander');
  git('config', 'user.email', 'lander@example.invalid');
  repo.put('shared.txt', 'one\ntwo\nthree\n');
  repo.commitAll();
  const { root: dir } = privateFixtureFiles('pullboard-pull-out-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git');
  git('clone', '-q', '--bare', repo.root, remote);
  const atRemote = (...args) => runFixtureSetupGit(args, { cwd: remote, env });
  return { ...repo, git, remote, atRemote, push: () => git('push', '-q', remote, `HEAD:${TRUNK}`) };
}

/** Land a branch writing `files` onto main with a --no-ff merge, push it, and return the merge commit. */
function land(repo, files) {
  repo.git('checkout', '-q', '-b', 'item');
  for (const [path, body] of Object.entries(files)) repo.put(path, body);
  repo.commitAll();
  repo.git('checkout', '-q', 'main');
  repo.git('merge', '-q', '--no-ff', 'item', '-m', 'feat(web): the item lands [G1]');
  repo.git('branch', '-q', '-D', 'item');
  repo.push();
  return repo.git('rev-parse', 'HEAD');
}

/** A board holding item `id` landed at `merged`; `pulling` adds the pull_out event that reopened it, and `epoch` its fenced gate row. */
function boardWith(t, rows) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  for (const { id, merged, pulling, epoch } of rows) {
    board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (?, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(id, STAMP, STAMP);
    board.db.exec('INSERT INTO temp.moving VALUES (1)');
    board.db.prepare("UPDATE item SET item_commit=?, item_merged_commit=?, item_built_by='core-1' WHERE item_id=?").run('a'.repeat(40), merged, id);
    board.db.exec('DELETE FROM temp.moving');
    store.logEvent(board, 'coordinator', 'merged', id, { commit: merged });
    if (pulling) store.logEvent(board, 'coordinator', 'pull_out', id, { commit: 'a'.repeat(40), mergedCommit: merged, builder: 'core-1' });
    for (let at = 1; at <= (epoch ?? 0); at++) {
      gateHopMove(board.db, { item: id, enabled: true, decide: () => ({ hop: { state: 'driven', owner: `driver-${at}`, epoch: at, leaseUntil: 0, attempts: at, commit: 'a'.repeat(40), digest: 'd1' } }) });
    }
  }
  return board;
}

/** The pull-out job rows and their steps, oldest first. */
function pullOutJobs(board) {
  return board.db.prepare("SELECT job_id id, job_item item, job_step step, job_candidate candidate, job_base base FROM job WHERE job_kind='pull-out' ORDER BY job_id").all()
    .map(row => ({ ...row, steps: board.db.prepare('SELECT job_step_name name, job_step_payload payload FROM job_step WHERE job_step_job=? ORDER BY rowid').all(row.id)
      .map(step => ({ name: step.name, payload: JSON.parse(step.payload) })) }));
}

/** The item's events of one kind, with their detail. */
function eventsOf(board, id, kind) {
  return board.db.prepare('SELECT event_by by, event_detail d FROM event WHERE item_id=? AND event_kind=? ORDER BY event_id').all(id, kind).map(row => ({ by: row.by, detail: JSON.parse(row.d) }));
}

test('landing.pull.runpulloutjob-creates-the-pull-out-job: clause 1: runPullOutJob creates the pull-out job only for a pulling item, pushes the revert through the fence at its hop epoch, then records pulled at the pushed revert [M2,R3,#9099]', t => {
  const repo = trunkRepo(t);
  const merged = land(repo, { 'web/x.js': 'landed\n', 'shared.txt': 'one\ntwo\nthree\nfour\n' });
  repo.put('api/y.js', 'later work\n');
  const trunk = repo.commitAll();
  repo.push();
  const board = boardWith(t, [{ id: 7, merged, pulling: true, epoch: 2 }, { id: 8, merged, pulling: false, epoch: 1 }]);

  // A landed item that is not pulling (every Steady item) creates no job and moves nothing.
  assert.deepEqual(runPullOutJob(board, { root: repo.root, remote: repo.remote, branch: TRUNK, item: 8, now: () => AT }, PUSH), { state: 'skipped' });
  assert.deepEqual(runPullOutJob(board, { root: repo.root, remote: repo.remote, branch: TRUNK, item: 99, now: () => AT }, PUSH), { state: 'skipped' }, 'no item, no job');
  assert.deepEqual(pullOutJobs(board), [], 'no pull-out job for an item whose landing is not pulling');
  assert.equal(repo.atRemote('rev-parse', TRUNK), trunk);

  const ran = runPullOutJob(board, { root: repo.root, remote: repo.remote, branch: TRUNK, item: 7, now: () => AT }, PUSH);
  assert.equal(ran.state, 'pulled');
  assert.equal(ran.trunk, trunk);
  assert.match(ran.revert, /^[a-f0-9]{40}$/u);

  // The revert is on the remote trunk, one parent on the old tip, and undoes only the landed change.
  assert.equal(repo.atRemote('rev-parse', TRUNK), ran.revert, 'the revert was pushed to trunk');
  assert.equal(repo.atRemote('rev-list', '--parents', '-n', '1', ran.revert), `${ran.revert} ${trunk}`);
  assert.equal(repo.atRemote('show', `${ran.revert}:shared.txt`), 'one\ntwo\nthree');
  assert.equal(repo.atRemote('show', `${ran.revert}:api/y.js`), 'later work');
  assert.throws(() => repo.atRemote('cat-file', '-e', `${ran.revert}:web/x.js`));

  // The push carried item 7's hop epoch: the fence ref names epoch 2's commit.
  assert.equal(repo.atRemote('rev-parse', hopFenceRef(7)), hopFenceObject(repo.root, { item: 7, epoch: 2 }), 'the fence holds the item\'s hop epoch');

  // One pull-out job for item 7, at the landed commit and the trunk it reverted on, its steps in order, done.
  const [job, ...others] = pullOutJobs(board);
  assert.deepEqual(others, []);
  assert.deepEqual([job.item, job.candidate, job.base, job.step], [7, merged, trunk, 'done']);
  assert.deepEqual(job.steps.filter(step => !step.name.startsWith('note:')).map(step => step.name), ['reverted', 'pushed']);
  assert.deepEqual(job.steps.find(step => step.name === 'pushed').payload, { revert: ran.revert, hops: [{ item: 7, epoch: 2 }] });

  // recordPulled ran at the pushed revert: one pulled event, and the landing is no longer pulling.
  assert.deepEqual(eventsOf(board, 7, 'pulled'), [{ by: 'coordinator', detail: { commit: ran.revert, reverted: merged } }]);
  assert.equal(store.pullingLanding(board, 7), null);

  // A second run finds nothing pulling and creates nothing more.
  assert.deepEqual(runPullOutJob(board, { root: repo.root, remote: repo.remote, branch: TRUNK, item: 7, now: () => AT }, PUSH), { state: 'skipped' });
  assert.equal(pullOutJobs(board).length, 1);
});

test('landing.pull.a-conflicting-revert-records-the-pull: clause 2: a conflicting revert records the pull-out job blocked naming the conflict, pushes nothing, and leaves the landing pulling [M2,R3,#9099]', t => {
  const repo = trunkRepo(t);
  const merged = land(repo, { 'web/x.js': 'landed\n', 'shared.txt': 'one\ntwo\nthree\nfour\n' });
  // Later trunk work rewrites the same lines the landing added, so its revert cannot apply.
  repo.put('shared.txt', 'one\ntwo\nthree\nFOUR\n');
  const trunk = repo.commitAll();
  repo.push();
  const board = boardWith(t, [{ id: 7, merged, pulling: true, epoch: 1 }]);

  const ran = runPullOutJob(board, { root: repo.root, remote: repo.remote, branch: TRUNK, item: 7, now: () => AT }, PUSH);
  assert.deepEqual(ran, { state: 'blocked', job: ran.job, conflicts: ['shared.txt'], trunk });

  const [job] = pullOutJobs(board);
  assert.equal(job.id, ran.job);
  assert.equal(job.step, 'blocked', 'the job is recorded blocked');
  const blocked = job.steps.find(step => step.name === 'blocked').payload;
  assert.deepEqual(blocked.conflicts, ['shared.txt'], 'the blocked step names the conflicted path');
  assert.match(blocked.reason, /conflicts .* in shared\.txt/u);

  assert.equal(repo.atRemote('rev-parse', TRUNK), trunk, 'trunk did not move');
  assert.throws(() => repo.atRemote('rev-parse', '--verify', '-q', hopFenceRef(7)), 'no fence was moved');
  assert.deepEqual(eventsOf(board, 7, 'pulled'), [], 'nothing is recorded pulled');
  assert.deepEqual(store.pullingLanding(board, 7), { mergedCommit: merged }, 'the landing is still pulling');
});
