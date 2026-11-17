/** Relay setup: a move from an agent worktree prints no relay-link line [C6,H5]. Split from setup.test.js to stay under the file budget. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  captureCommandInProcess,
  runCliInProcess,
} from '../../tests/fixtures/process.js';
import { updateRelayMachine } from '../../../../packages/link/index.js';
import {
  FIXTURE_MODEL,
  privateFixtureFiles,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';

/** Run one CLI command in plain words inside a private home, returning its exit code and both streams. */
async function relayOffCommand(cwd, env, args) {
  const result = await runCliInProcess(args, { cwd, env });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Build a set-up-once machine with the relay off, a board with an agent worktree, and optionally a stale registry entry. */
async function relayOffWorktree(t, { stale }) {
  const scratch = privateFixtureFiles('pullboard-relay-off-').root;
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const home = join(scratch, 'home');
  mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(scratch, 'machine'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Relay Fixture', GIT_AUTHOR_EMAIL: 'relay-fixture@example.com',
    GIT_COMMITTER_NAME: 'Relay Fixture', GIT_COMMITTER_EMAIL: 'relay-fixture@example.com' };
  for (const name of ['PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN', ...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[name];
  /** Make one committed repository with a GitHub origin, registered through the production CLI. */
  const board = async name => {
    const root = join(scratch, name);
    mkdirSync(root);
    for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'chore: ' + name],
      ['remote', 'add', 'origin', 'git@github.com:fixture/' + name + '.git']]) runFixtureGit(args, { cwd: root, env });
    const init = await relayOffCommand(root, env, ['init', '--json']);
    assert.equal(init.code, 0, init.stderr);
    runFixtureGit(['add', '-A'], { cwd: root, env });
    runFixtureGit(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'chore: pullboard files'], { cwd: root, env });
    return root;
  };
  const root = await board('repo');
  if (stale) {
    // A registered folder that is no longer a git work tree, like a deleted scratch clone.
    const gone = await board('stale-scratch');
    rmSync(join(gone, '.git'), { recursive: true, force: true });
  }
  // Set up once, then the relay is off: auto-link stays on for the owner, and no board on this machine is linked.
  const saved = await captureCommandInProcess(() => {
    updateRelayMachine(state => { state.autoLink = true; state.owner = { account: 'fixture-account', url: 'http://127.0.0.1:9' }; });
    return 0;
  }, [], { cwd: root, env });
  assert.equal(saved.status, 0, saved.stderr);
  const worktree = join(scratch, 'repo-core-1');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'core/1', worktree], { cwd: root, env });
  const joined = await relayOffCommand(worktree, env, ['join', 'review', '--model', FIXTURE_MODEL]);
  assert.equal(joined.code, 0, joined.stderr);
  return { worktree, env };
}

test('a move from an agent worktree prints no relay-link line [C6,H5]', async (t) => {
  for (const stale of [true, false]) {
    const { worktree, env } = await relayOffWorktree(t, { stale });
    const move = await relayOffCommand(worktree, env, ['spec', 'draft', 'A fixture row', '--section', 'G']);
    const label = stale ? 'with a stale registry entry' : 'the control with no stale entry';
    assert.equal(move.code, 0, `the move succeeds ${label}: ${move.stderr}`);
    assert.doesNotMatch(move.stdout + move.stderr, /not linked|NOT_A_REPO|not inside a git work tree/u, `the move prints only its result ${label}`);
    assert.equal(move.stderr, '', `the move writes nothing to stderr ${label}`);
  }
});
