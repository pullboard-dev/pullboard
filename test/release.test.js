/**
 * A packed release works on a machine that has only it (P2, I1): the tarball npm would publish,
 * installed into an empty prefix with no network, runs the whole loop from a fresh git repo. Every
 * command, and every git hook, runs the installed pullboard, never this repo's bin.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const PUBLISHED = ['LICENSE', 'NOTICE', 'README.md', 'bin', 'docs', 'package.json', 'skills', 'src'];
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('a packed release installs with no network and runs the whole loop from a fresh repo [P2, I1]', { skip: process.platform === 'win32' && 'the installed bin layout differs on Windows' }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-release-')));
  dirs.push(dir);
  const npmEnv = { ...process.env, npm_config_cache: join(dir, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_loglevel: 'error' };

  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dir], { cwd: ROOT, env: npmEnv, encoding: 'utf8' }));
  const tops = [...new Set(packed.files.map((file) => file.path.split('/')[0]))].sort();
  assert.deepEqual(tops, PUBLISHED, 'the tarball holds the package and nothing else: no tests, no board');

  const prefix = join(dir, 'prefix');
  const install = spawnSync('npm', ['install', '--global', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', join(dir, packed.filename)], { env: npmEnv, encoding: 'utf8' });
  assert.equal(install.status, 0, `installs with no network: ${install.stderr}`);
  const installed = join(prefix, 'lib', 'node_modules', '@pullboard', 'local');
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).dependencies, undefined, 'no dependencies');
  assert.ok(!existsSync(join(installed, 'node_modules')), 'nothing was installed beside it');
  const bin = join(prefix, 'bin', 'pullboard');

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
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  /** Run the installed pullboard and require it to succeed. */
  const pullboard = (cwd, ...args) => {
    const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, `pullboard ${args.join(' ')}: ${result.stderr}${result.stdout}`);
    return result.stdout;
  };
  assert.match(execFileSync('sh', ['-c', 'command -v pullboard'], { env, encoding: 'utf8' }), new RegExp(`^${prefix}/bin/pullboard`), 'the hooks find the installed pullboard first');

  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const initialized = pullboard(repo, 'init');
  for (const line of ['wrote pullboard.json', 'wrote SPEC.md', 'wrote .githooks/pre-commit', 'set core.hooksPath to .githooks', 'opened the board in the git dir; this checkout is the coordinator']) {
    assert.ok(initialized.includes(line), `init says: ${line}`);
  }
  assert.ok(existsSync(join(repo, '.githooks', 'pre-commit')) && existsSync(join(repo, '.git', 'pullboard', 'board.sqlite')), 'init wrote the hooks and the board');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'test -f web/greet.txt', lanes: { web: { owns: ['web/'], specs: ['G1'] } } }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), '# Greeter\n\n## G · Goals\n- G1 [approved, must] It greets. | gate: test\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  assert.equal(pullboard(repo, 'add', 'web', 'Greet', '--specs', 'G1').trim(), '#1');

  assert.match(pullboard(repo, 'worktree', 'web'), /joined as web-1/);
  const builder = join(dir, 'repo-web-1');
  assert.match(pullboard(builder, 'claim', '1'), /claimed #1/);
  mkdirSync(join(builder, 'web'));
  writeFileSync(join(builder, 'web', 'greet.txt'), 'hello\n');
  git(builder, 'add', '-A');
  git(builder, 'commit', '-q', '-m', 'feat(web): greet [G1]');
  const commit = git(builder, 'rev-parse', 'HEAD');
  assert.match(pullboard(builder, 'submit', '1'), new RegExp(`submitted #1 at ${commit.slice(0, 12)}; gate green`));

  assert.match(pullboard(repo, 'worktree', 'web'), /joined as web-2/);
  const verifier = join(dir, 'repo-web-2');
  git(verifier, 'switch', '-q', '--detach', commit);
  assert.match(pullboard(verifier, 'verify', '1', 'accept', '--note', 'checked out the commit; web/greet.txt says hello'), /verified #1/);

  git(repo, 'merge', '-q', '--no-edit', commit);
  const merge = git(repo, 'rev-parse', 'HEAD');
  assert.equal(pullboard(repo, 'merged', '1', merge).trim(), `#1 merged as ${merge.slice(0, 12)}`);
  const shown = pullboard(repo, 'show', '1');
  assert.match(shown, /#1 {2}verified/);
  assert.match(shown, /merged as [0-9a-f]{12}/);
});
