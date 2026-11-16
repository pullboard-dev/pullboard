/** @pullboard-test-input source-cell link apps/cli */
/** relay off from any worktree excludes the board once, and the main checkout can run it with relay.excludeByBoard on [C7,#9415]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { excludeRelayByPerson } from '../../../src/io/relay/exclusion.js';
import { readRelayMachine } from '../../../src/io/relay/machine.js';
import { bindWriteSession } from '../../../../../apps/cli/src/io/join.js';
import { bindLocalSession } from '../../../../seats/index.js';
import { agentSessionDigest } from '../../../../person/index.js';
import { repoInfo } from '../../../../git/index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { openCellBoard } from '../../../../store/tests/fixtures/cell.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

const IO = { personChannel: 'view' };
const records = () => (root, work) => work(openCellBoard(':memory:', { now: () => new Date('2026-11-16T12:00:00.000Z') }));

/** A board with a second worktree under a private machine home, relay.excludeByBoard on. */
function board(t, prefix) {
  const files = privateFixtureFiles(prefix);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = join(files.root, 'machine-home');
  mkdirSync(home, { recursive: true });
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  fixtureMachineSettings(home, { relay: { excludeByBoard: true } });
  const step = (cwd, ...args) => runFixtureGit(args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const repo = join(files.root, 'repo');
  mkdirSync(repo);
  step(repo, 'init', '-q', '-b', 'main');
  step(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  const second = join(files.root, 'second');
  step(repo, 'worktree', 'add', '-q', second, '-b', 'second');
  return { repo, second };
}

test('clause 1: relay off from two worktrees of one board records one board exclusion [C7,#9415]', t => {
  const { repo, second } = board(t, 'pullboard-off-any-worktree-');
  assert.equal(excludeRelayByPerson(second, IO, { localRecords: records() }), true);
  const first = readRelayMachine().excluded.slice();
  assert.equal(first.length, 1);
  assert.equal(excludeRelayByPerson(repo, IO, { localRecords: records() }), true);
  assert.deepEqual(readRelayMachine().excluded, first, 'the second relay off adds no second entry');
});

test('clause 2: relay off in a main checkout bound to another session is not refused NOT_YOUR_CHECKOUT [C7,#9415]', async t => {
  const { repo } = board(t, 'pullboard-off-main-checkout-');
  const marker = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID };
  t.after(() => { for (const [key, value] of Object.entries(marker)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_SESSION_ID = 'other-session';
  const lease = await bindLocalSession(repoInfo(repo), { agent: 'coordinator', digest: agentSessionDigest(), keepLease: true });
  lease.release();
  process.env.CLAUDE_CODE_SESSION_ID = 'this-session';
  const io = { cwd: repo };
  assert.equal(await bindWriteSession(io, ['relay', 'off'], {}), undefined, 'relay off takes no checkout lease');
  await assert.rejects(bindWriteSession(io, ['relay', 'on'], {}), error => error.code === 'NOT_YOUR_CHECKOUT');
});
