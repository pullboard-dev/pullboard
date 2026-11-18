/** @pullboard-test-input apps/cli/pullboard.js */
/** A boardless clone with board.url set runs the pre-commit lane check with the lane the served board names [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpBox } from '../../fixtures/api.js';
import { runFixtureChildAsync } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { runCliInProcess } from '../../fixtures/process.js';

/** A served board with an app-lane agent, its local seat, and a boardless clone on its own machine home using its hooks. */
async function remoteSeat(t) {
  const box = await apiHttpBox(t);
  const linked = join(box.dir, 'agent');
  runFixtureGit(['worktree', 'add', '-q', '--detach', linked], { cwd: box.root, env: box.env, stdio: 'pipe' });
  const joined = await runCliInProcess(['join', 'app', '--json'], { cwd: linked, env: box.env });
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  const agent = JSON.parse(joined.stdout).agent;
  const clone = join(box.dir, 'studio');
  runFixtureGit(['clone', '-q', box.root, clone], { cwd: box.dir, env: box.env, stdio: 'pipe' });
  // Hook settings stay in each repository's own config; a clone opts into the committed hooks as a seat host does.
  runFixtureGit(['config', 'core.hooksPath', '.githooks'], { cwd: clone, env: box.env, stdio: 'pipe' });
  const machine = join(box.dir, 'studio-home');
  mkdirSync(machine);
  const env = { ...box.env, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_AGENT: agent };
  /** Run the real CLI dispatch in the clone, awaited, so the in-process server keeps answering. */
  const run = (...args) => runCliInProcess(args, { cwd: clone, env });
  /** Stage one new file and commit it through the real hooks, without blocking the server. */
  const commit = (cwd, path, childEnv = env) => {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), `${path}\n`);
    runFixtureGit(['add', '--', path], { cwd, env: childEnv, stdio: 'pipe' });
    return runFixtureChildAsync('git', ['commit', '-q', '-m', 'feat: lane work [G1]'], { cwd, env: childEnv });
  };
  return { box, agent, linked, clone, env, run, commit };
}

/** Whether the clone holds a board file a local board command would create or open. */
function cloneBoard(clone) {
  return existsSync(join(clone, '.git', 'pullboard', 'board.sqlite'));
}

/** Point the clone at the served board with its key. */
async function linkBoard(seat, url = seat.box.origin) {
  assert.equal((await seat.run('settings', 'board.url', url)).status, 0);
  assert.equal((await seat.run('settings', 'board.token', '--', seat.box.key)).status, 0);
}

/** The lane problem line a blocked pre-commit prints, without the absolute checkout it ran in. */
function laneLine(stderr) {
  return /^ {2}- outside the app lane: .*$/mu.exec(stderr)?.[0];
}

test('cli.io-remote-lane-hook.a-boardless-clone-commits-files-in-the: a boardless clone commits files in the seat\'s lane through the pre-commit hook [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board and a hooked commit, not a throughput claim.
async (t) => {
  const seat = await remoteSeat(t);
  await linkBoard(seat);
  const inside = await seat.commit(seat.clone, 'app/remote-lane.txt');
  assert.equal(inside.status, 0, inside.stdout + inside.stderr);
  assert.match(runFixtureGit(['log', '-1', '--name-only', '--format='], { cwd: seat.clone, env: seat.env }), /^app\/remote-lane\.txt$/mu);
  assert.equal(cloneBoard(seat.clone), false, 'the hook opened no local board');
});

test('cli.io-remote-lane-hook.a-boardless-clone-refuses-a-file-outside: a boardless clone refuses a file outside the lane with the local check\'s refusal [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board and two hooked commits, not a throughput claim.
async (t) => {
  const seat = await remoteSeat(t);
  await linkBoard(seat);
  const local = await seat.commit(seat.linked, 'docs/outside.txt', seat.box.env);
  assert.equal(local.status, 1, local.stdout + local.stderr);
  const remote = await seat.commit(seat.clone, 'docs/outside.txt');
  assert.equal(remote.status, 1, remote.stdout + remote.stderr);
  assert.match(remote.stderr, /^pullboard pre-commit: blocked$/mu);
  assert.ok(laneLine(local.stderr), local.stderr);
  assert.equal(laneLine(remote.stderr), laneLine(local.stderr));
  assert.equal(cloneBoard(seat.clone), false, 'the refused hook opened no local board');
});

test('cli.io-remote-lane-hook.an-unreachable-board-refuses-the-commit-with: an unreachable board refuses the commit with a next step instead of passing it [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init and a hooked commit, not a throughput claim.
async (t) => {
  const seat = await remoteSeat(t);
  await linkBoard(seat, 'http://127.0.0.1:9');
  const before = runFixtureGit(['rev-parse', 'HEAD'], { cwd: seat.clone, env: seat.env });
  const away = await seat.commit(seat.clone, 'app/unreached.txt');
  assert.equal(away.status, 1, away.stdout + away.stderr);
  assert.match(away.stderr, /^pullboard: \[BOARD_UNREACHABLE\] .*\nnext: .+/mu);
  assert.equal(runFixtureGit(['rev-parse', 'HEAD'], { cwd: seat.clone, env: seat.env }), before, 'no commit was made');
  assert.equal(cloneBoard(seat.clone), false, 'the refused hook opened no local board');
});
