/** @pullboard-test-input source-cell apps/cli */
/** relay off in a main checkout bound to another session is not refused with relay.excludeByBoard on [C7,#9415]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bindWriteSession } from '../../src/io/join.js';
import { bindLocalSession } from '../../../../packages/seats/index.js';
import { agentSessionDigest } from '../../../../packages/person/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../packages/gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';

test('clause 2: relay off in a main checkout bound to another session is not refused NOT_YOUR_CHECKOUT [C7,#9415]', async t => {
  const files = privateFixtureFiles('pullboard-off-main-checkout-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = join(files.root, 'machine-home');
  mkdirSync(home, { recursive: true });
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  fixtureMachineSettings(home, { relay: { excludeByBoard: true } });
  const repo = join(files.root, 'repo');
  mkdirSync(repo);
  const step = (cwd, ...args) => runFixtureGit(args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  step(repo, 'init', '-q', '-b', 'main');
  step(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
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
