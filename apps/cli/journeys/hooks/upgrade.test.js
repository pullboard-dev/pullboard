/** Hooks written by the release before this one keep working, and doctor names them [R4,I1] (#7760). */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import packageData from '../../../../package.json' with { type: 'json' };
import { hookScript } from '../../../../packages/commits/index.js';
import { hookStanding } from '../../../../packages/commits/index.js';
import { releaseBefore } from '../../../../packages/commits/index.js';
import { staleHookProblems } from '../../../../packages/commits/index.js';

const CLI = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
const HOOK_NAMES = ['pre-commit', 'commit-msg'];
const run = (cwd, command, args, env = {}) => spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env } });

/** A repo whose hooks a given release wrote, with a seat worktree and a `pullboard` on PATH that is this checkout's CLI. */
function upgradedRepo(t, hooksVersion) {
  const base = privateFixtureFiles('pullboard-hook-upgrade-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = join(base, 'main'), seat = join(base, 'seat'), bin = join(base, 'bin');
  mkdirSync(main); mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec node ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'f@example.com']]) run(main, 'git', args);
  mkdirSync(join(main, '.githooks'));
  for (const hook of HOOK_NAMES) {
    writeFileSync(join(main, '.githooks', hook), hookScript(hook, hooksVersion));
    chmodSync(join(main, '.githooks', hook), 0o755);
  }
  run(main, 'git', ['add', '.']);
  run(main, 'git', ['commit', '-q', '-m', 'chore: base']); // Hooks are wired afterwards, so no commit here needs to skip them.
  run(main, 'git', ['config', 'core.hooksPath', '.githooks']);
  run(main, 'git', ['worktree', 'add', '-q', '--detach', seat]);
  return { main, seat, env: { PATH: `${bin}:${process.env.PATH}` } };
}

test('the release before this one is the one hooks may still come from [R4]', () => {
  assert.equal(releaseBefore('0.9.4'), '0.9.3');
  assert.equal(releaseBefore('0.10.0'), null, 'a minor bump is not guessed');
  const [hook] = HOOK_NAMES;
  const before = hookScript(hook, releaseBefore('0.9.4'));
  assert.equal(hookStanding('0.9.4', [before]).state, 'accepted');
  assert.equal(hookStanding('0.9.4', [hookScript(hook, '0.9.4')]).state, 'current');
  assert.equal(hookStanding('0.9.4', [hookScript(hook, '0.9.2')]).state, 'stale', 'two releases back is outside the window');
  assert.equal(hookStanding('0.9.4', [before, hookScript(hook, '0.9.4')]).state, 'stale', 'mixed hooks are not trusted');
  assert.equal(hookStanding('0.9.4', ['#!/bin/sh\necho mine\n']).state, 'none');
});

test('a version probe inside a git hook hears the hooks one release back, and nobody else does [R4,I1]', (t) => {
  const prior = releaseBefore(packageData.version);
  assert.ok(prior, 'the running release has a release before it');
  const repo = upgradedRepo(t, prior);
  const probe = (cwd, env) => run(cwd, 'node', [CLI, '--version'], env).stdout.trim();
  assert.equal(probe(repo.seat, { GIT_EXEC_PATH: '/usr/lib/git-core' }), prior, 'inside a hook in a seat worktree');
  assert.equal(probe(repo.seat, { GIT_EXEC_PATH: '' }), packageData.version, 'a person asking in a shell hears the truth');
  const old = upgradedRepo(t, '0.0.1');
  assert.equal(probe(old.seat, { GIT_EXEC_PATH: '/usr/lib/git-core' }), packageData.version, 'two releases back still hears the truth');
});

test('a seat worktree commits under hooks the last release installed [R4,I1]', (t) => {
  const repo = upgradedRepo(t, releaseBefore(packageData.version));
  writeFileSync(join(repo.seat, 'a.txt'), 'a\n');
  run(repo.seat, 'git', ['add', 'a.txt']);
  const commit = run(repo.seat, 'git', ['commit', '-q', '-m', 'chore: a seat commit'], repo.env);
  assert.doesNotMatch(commit.stderr, /stopped before running any rule|Run: pullboard init/u, commit.stderr);
});

test('hooks two releases back refuse with a command that works from the worktree [R4,I1]', (t) => {
  const repo = upgradedRepo(t, '0.0.1');
  run(repo.seat, 'git', ['add', '-A']);
  const commit = run(repo.seat, 'git', ['commit', '-q', '--allow-empty', '-m', 'chore: a seat commit'], repo.env);
  assert.notEqual(commit.status, 0);
  assert.match(commit.stderr, new RegExp(`Run: cd "${repo.main.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}" && pullboard init`, 'u'), 'init runs where init is allowed');
});

test('doctor names hooks from an older release and the step that refreshes them [R4]', (t) => {
  const prior = releaseBefore(packageData.version);
  const back = upgradedRepo(t, prior);
  const [found] = staleHookProblems(back.seat, packageData.version);
  assert.equal(found.code, 'HOOKS_OLDER_RELEASE');
  assert.match(found.message, new RegExp(`Pullboard ${prior.replaceAll('.', '\\.')}.*still run`, 'u'));
  assert.match(found.next, /main checkout.*pullboard init.*commit/u);
  const stale = staleHookProblems(upgradedRepo(t, '0.0.1').seat, packageData.version)[0];
  assert.match(stale.message, /stop every commit/u);
  const current = upgradedRepo(t, packageData.version);
  assert.deepEqual(staleHookProblems(current.seat, packageData.version), []);
});
