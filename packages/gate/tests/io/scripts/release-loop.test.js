/**
 * The installed release carries one item from the builder's commit to the merge (P2, I1): submit, the pulled-gate settle,
 * verify, merged and show, every command through the installed pullboard. Pack, install and the set-up steps are
 * repeated from release.test.js so the runner can shard the two launch groups in parallel.
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync } from '../../fixtures/child.js';
import { runFixtureChild as spawnSync } from '../../fixtures/child.js';
import { runFixtureChild } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { runFixtureSetupGit } from '../../fixtures/child.js';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '../../../../..');
const PUBLISHED = ['CHANGELOG.md', 'LICENSE', 'README.md', 'apps', 'docs', 'package.json', 'packages', 'skills'];
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('gate.io-scripts-release-loop.a-packed-release-runs-the-builder: clause 2: a packed release runs the builder commit, submit, settle, verify, merge and show loop through the installed bin [P2, I1]', { skip: process.platform === 'win32' && 'the installed bin layout differs on Windows' }, async (t) => {
  // Each step's milliseconds are printed as a diagnostic so a slow run names its slow step (#9540).
  const sums = { pack: 0, install: 0, launch: 0 };
  /** Time one step of the release run, print it, and add it to its kind's sum. */
  const timed = (kind, name, run) => {
    const start = performance.now();
    try { return run(); } finally {
      const ms = Math.round(performance.now() - start);
      sums[kind] += ms;
      t.diagnostic(`step ${name} ${ms} ms`);
    }
  };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-release-')));
  dirs.push(dir);
  const npmEnv = { ...process.env, npm_config_cache: join(dir, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_loglevel: 'error' };

  const [packed] = JSON.parse(timed('pack', 'pack', () => execFileSync('npm', ['pack', '--json', '--pack-destination', dir], { cwd: ROOT, env: npmEnv, encoding: 'utf8' })));
  const tops = [...new Set(packed.files.map((file) => file.path.split('/')[0]))].sort();
  assert.deepEqual(tops, PUBLISHED, 'the tarball holds the package and nothing else: no tests, no board');

  const prefix = join(dir, 'prefix');
  const install = timed('install', 'install', () => runFixtureChild('npm', ['install', '--global', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', join(dir, packed.filename)], { env: npmEnv, encoding: 'utf8' }));
  assert.equal(install.status, 0, `installs with no network: ${install.stderr}`);
  const installed = join(prefix, 'lib', 'node_modules', 'pullboard');
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).dependencies, undefined, 'no dependencies');
  assert.ok(!existsSync(join(installed, 'node_modules')), 'nothing was installed beside it');
  const bin = join(prefix, 'bin/pullboard');

  const env = {
    ...process.env,
    PATH: `${join(prefix, 'bin')}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
    PULLBOARD_MODEL: 'Release Test Model',
  };
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  /** Run the installed pullboard and require it to succeed. */
  const pullboard = (cwd, ...args) => {
    const result = timed('launch', `launch ${args.join(' ')}`, () => runFixtureChild(bin, args, { cwd, env, encoding: 'utf8' }));
    assert.equal(result.status, 0, `pullboard ${args.join(' ')}: ${result.stderr}${result.stdout}`);
    return result.stdout;
  };
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  pullboard(repo, 'init', '--verbose');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'test -f web/greet.txt', lanes: { web: { owns: ['web/'], specs: ['G1'] } } }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), '# Greeter\n\n## G · Goals\n- G1 [approved, must] It greets. | gate: test\n');
  git(repo, 'add', '-A');
  // The set-up commit is not the claim, so it skips hooks (one Node launch saved); the builder's commit below runs the installed hooks.
  runFixtureSetupGit(['commit', '-q', '-m', 'chore: set up pullboard'], { cwd: repo, env });
  assert.equal(pullboard(repo, 'add', 'web', 'Greet', '--specs', 'G1').split('\n')[0].trim(), '#1');

  assert.match(pullboard(repo, 'worktree', 'web'), /joined as web-1/);
  const builder = join(dir, 'repo-web-1');
  assert.match(pullboard(builder, 'claim', '1'), /claimed #1/);
  mkdirSync(join(builder, 'web'));
  writeFileSync(join(builder, 'web', 'greet.txt'), 'hello\n');
  git(builder, 'add', '-A');
  git(builder, 'commit', '-q', '-m', 'feat(web): greet [G1]');
  const commit = git(builder, 'rev-parse', 'HEAD');
  const submitted = pullboard(builder, 'submit', '1');
  assert.match(submitted, new RegExp(`#1 is in the gate as job gate:1:${commit.slice(0, 12)}:[a-z0-9]+: a runner pulls the whole gate and posts one receipt`));
  // The verifier's worktree is made while the pulled gate settles, so its Node launches overlap the runner's wait.
  assert.match(pullboard(repo, 'worktree', 'web'), /joined as web-2/);
  const verifier = join(dir, 'repo-web-2');
  git(verifier, 'switch', '-q', '--detach', commit);
  // The pulled gate settles on the machine's local runner; verify needs its receipt applied (#6249, #7283, #7867): read the
  // item through the installed bin until the receipt has moved it off claimed.
  const deadline = Date.now() + 180_000;
  while (!/#1 {2}submitted/.test(pullboard(builder, 'show', '1'))) {
    assert.ok(Date.now() < deadline, 'the pulled gate settled within 180 s');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }

  assert.match(pullboard(verifier, 'verify', '1', 'accept', '--note', 'checked out the commit; web/greet.txt says hello'), /verified #1/);

  git(repo, 'merge', '-q', '--no-edit', commit);
  const merge = git(repo, 'rev-parse', 'HEAD');
  // Accepted work lands into the checked-out trunk on its own (b76853abf0, #7951), so the board may already hold the merge when
  // the hand command runs; the deferred-checks wording is proved in apps/cli/journeys/merged/fast.test.js. Here the commit
  // is recorded exactly once either way, and the replay names it.
  const merged = pullboard(repo, 'merged', '1', merge);
  assert.match(merged, new RegExp(`#1 (merged as|is already merged as) ${merge.slice(0, 12)}`), 'merged records the commit or names the landing that already did');
  const shown = pullboard(repo, 'show', '1');
  assert.match(shown, /#1 {2}verified/);
  assert.match(shown, /merged as [0-9a-f]{12}/);
  t.diagnostic(`step sums pack ${sums.pack} ms, install ${sums.install} ms, launch ${sums.launch} ms`);
});
