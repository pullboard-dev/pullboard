/**
 * A packed release works on a machine that has only it (P2, I1): the tarball npm would publish,
 * installed into an empty prefix with no network, sets up a fresh git repo and claims an item. Every
 * command, and every git hook, runs the installed pullboard, never this repo's bin. The loop from the
 * builder's commit to the merge is release-loop.test.js.
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

test('gate.io-scripts-release.a-packed-release-installs-with-no: clause 1: a packed release installs with no network, sets up a fresh repo and claims an item [P2, I1]', { skip: process.platform === 'win32' && 'the installed bin layout differs on Windows' }, async (t) => {
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
  assert.match(execFileSync('sh', ['-c', 'command -v pullboard'], { env, encoding: 'utf8' }), new RegExp(`^${prefix}/bin/pullboard`), 'the hooks find the installed pullboard first');

  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const initialized = pullboard(repo, 'init', '--verbose');
  for (const line of ['wrote pullboard.json', 'wrote SPEC.md', 'wrote .githooks/pre-commit', 'set core.hooksPath to .githooks', 'opened the board in the git dir; this checkout is the coordinator']) {
    assert.ok(initialized.includes(line), `init says: ${line}`);
  }
  assert.ok(existsSync(join(repo, '.githooks', 'pre-commit')) && existsSync(join(repo, '.git', 'pullboard', 'board.sqlite')), 'init wrote the hooks and the board');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'test -f web/greet.txt', lanes: { web: { owns: ['web/'], specs: ['G1'] } } }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), '# Greeter\n\n## G · Goals\n- G1 [approved, must] It greets. | gate: test\n');
  git(repo, 'add', '-A');
  // The set-up commit is not the claim, so it skips hooks (one Node launch saved); the builder's commit below runs the installed hooks.
  runFixtureSetupGit(['commit', '-q', '-m', 'chore: set up pullboard'], { cwd: repo, env });
  assert.equal(pullboard(repo, 'add', 'web', 'Greet', '--specs', 'G1').split('\n')[0].trim(), '#1');

  assert.match(pullboard(repo, 'worktree', 'web'), /joined as web-1/);
  const builder = join(dir, 'repo-web-1');
  assert.match(pullboard(builder, 'claim', '1'), /claimed #1/);
  t.diagnostic(`step sums pack ${sums.pack} ms, install ${sums.install} ms, launch ${sums.launch} ms`);
});
