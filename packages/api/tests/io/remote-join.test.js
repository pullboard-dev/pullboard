/** @pullboard-test-input apps/cli/pullboard.js */
/** A seat on another machine joins a served board over the API and its moves run there, not refused WRONG_BOARD [P7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { apiHttpBox } from '../../../../apps/cli/tests/fixtures/api.js';
import { runFixtureChildAsync } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';
import { FIXTURE_MODEL } from '../../../../apps/cli/tests/fixtures/testkit.js';

const BIN = resolve(import.meta.dirname, '../../../../apps/cli/pullboard.js');

/** A served board and a boardless clone on its own machine home that points at the board by URL and key. */
async function remoteClone(t) {
  const box = await apiHttpBox(t);
  const clone = join(box.dir, 'studio');
  runFixtureGit(['clone', '-q', box.root, clone], { cwd: box.dir, env: box.env, stdio: 'pipe' });
  const machine = join(box.dir, 'studio-home');
  mkdirSync(machine);
  const env = { ...box.env, PULLBOARD_MACHINE_HOME: machine };
  /** Run the real CLI in the clone without blocking the in-process server. */
  const run = (...args) => runFixtureChildAsync(process.execPath, [BIN, ...args], { cwd: clone, env });
  assert.equal((await run('settings', 'board.url', box.origin)).status, 0);
  assert.equal((await run('settings', 'board.token', '--', box.key)).status, 0);
  return { box, clone, env, run };
}

/** The served board's agent row for a name, from its state. */
async function servedAgent(box, name) {
  const { document } = await box.call(`${box.path}/state`);
  return ((document.state ?? document).agents ?? []).find((entry) => entry.agent_id === name);
}

test('clause 1: join <lane> with board.url set registers an agent on the served board with no board-host path [P7]', { timeout: 60_000 }, // budget: hang ceiling for fixture init, a served board and three CLI children, not a throughput claim.
async (t) => {
  const seat = await remoteClone(t);
  const joined = await seat.run('join', 'app', '--model', FIXTURE_MODEL, '--json');
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  const { agent } = JSON.parse(joined.stdout);
  assert.match(agent, /^app-/u);
  const stored = execFileSync('git', ['config', '--get', 'pullboard.agent'], { cwd: seat.clone, env: seat.env, encoding: 'utf8' }).trim();
  assert.equal(stored, agent, 'the worktree keeps the agent name in git config pullboard.agent');
  const row = await servedAgent(seat.box, agent);
  assert.equal(row?.agent_lane, 'app');
  assert.equal(existsSync(String(row.agent_path ?? '')), false, 'the agent has no path on the board host');
  assert.equal(String(row.agent_path ?? '').startsWith(seat.clone), false, 'the board host never records the remote clone path');
  assert.equal(existsSync(join(seat.clone, '.git', 'pullboard', 'board.sqlite')), false, 'join opened no local board');
  const me = await seat.run('whoami', '--json');
  assert.equal(me.status, 0, me.stdout + me.stderr);
  assert.equal(JSON.parse(me.stdout).id, agent, 'later board calls name the joined agent');
});

test('clause 2: a move posted as the remote agent runs instead of refusing WRONG_BOARD [P7]', { timeout: 60_000 }, // budget: hang ceiling for fixture init, a served board and three CLI children, not a throughput claim.
async (t) => {
  const seat = await remoteClone(t);
  const joined = await seat.run('join', 'app', '--model', FIXTURE_MODEL, '--json');
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  const { agent } = JSON.parse(joined.stdout);
  const moved = await seat.box.call(`${seat.box.path}/moves`, { verb: 'shout', agent, args: { to: 'coordinator', kind: 'question', text: 'remote seat reporting' } });
  assert.equal(moved.status, 200, JSON.stringify(moved.document));
  assert.equal(moved.document.event.event_by, agent, 'the move acts as the remote agent, not the coordinator');
});

test('clause 3: a local agent whose worktree belongs to another board still refuses WRONG_BOARD [P7]', { timeout: 60_000 }, // budget: hang ceiling for fixture init, a served board and two CLI children, not a throughput claim.
async (t) => {
  const box = await apiHttpBox(t);
  const linked = join(box.dir, 'agent');
  runFixtureGit(['worktree', 'add', '-q', '--detach', linked], { cwd: box.root, env: box.env, stdio: 'pipe' });
  const agent = box.cli(linked, 'join', 'app').agent;
  // The joined path now holds another repository, so its worktree belongs to another board.
  runFixtureGit(['worktree', 'remove', '--force', linked], { cwd: box.root, env: box.env, stdio: 'pipe' });
  rmSync(linked, { recursive: true, force: true });
  runFixtureGit(['clone', '-q', box.root, linked], { cwd: box.dir, env: box.env, stdio: 'pipe' });
  const moved = await box.call(`${box.path}/moves`, { verb: 'shout', agent, args: { to: 'coordinator', text: 'from another board' } });
  assert.equal(moved.status, 403, JSON.stringify(moved.document));
  assert.equal(moved.document.error.code, 'WRONG_BOARD');
});
