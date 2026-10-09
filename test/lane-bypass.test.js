/** Reproduce lane-policy bypasses with private Git repositories and their installed hooks [L1,L3]. */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, runFixtureChild as spawnSync, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { submissionPaths } from '../src/trusted-policy.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const SANDBOXES = [];
const SPEC = '# Lane bypass fixture\n\n## Goals\n- G1 [approved, must] The web lane owns its page. | gate: true\n- G2 [approved, must] The API lane owns its route. | gate: true\n';

/** Remove all temporary repositories once the test file finishes. */
function cleanupSandboxes() {
  for (const directory of SANDBOXES) rmSync(directory, { recursive: true, force: true });
}

after(cleanupSandboxes);

/** Quote a path for the shell shim installed into each private repository's PATH. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Create private Git settings, HOME folders and a PATH shim that runs this checkout's source CLI. */
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-lane-bypass-')));
  SANDBOXES.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Lane bypass fixture',
    GIT_AUTHOR_EMAIL: 'lane-bypass@example.invalid',
    GIT_COMMITTER_NAME: 'Lane bypass fixture',
    GIT_COMMITTER_EMAIL: 'lane-bypass@example.invalid',
    PATH: `${bin}:${process.env.PATH}`,
  });
  mkdirSync(env.HOME);
  /** Run Git in a fixture repo and return trimmed output. */
  function git(cwd, ...args) {
    return runFixtureGit(args, { cwd, env });
  }
  /** Run Git while preserving expected hook failures for assertions. */
  function tryGit(cwd, ...args) {
    return runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
  }
  /** Run this checkout's CLI in the selected private working tree. */
  function run(cwd, ...args) {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr, failure: result.failure };
  }
  return { dir, env, git, tryGit, run };
}

/** Initialize Pullboard and commit the two-lane policy on a private primary branch. */
function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').code, 0);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  config.gate = 'true';
  config.lanes = { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } };
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  mkdirSync(join(repo, 'web'));
  mkdirSync(join(repo, 'api'));
  writeFileSync(join(repo, 'web', 'page.txt'), 'web baseline\n');
  writeFileSync(join(repo, 'api', 'route.txt'), 'api baseline\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up two lane fixture');
  return { ...box, repo };
}

/** Make a real joined worktree and branch for a lane. */
function laneWorktree(box, lane, branch) {
  const path = join(box.dir, `${lane}-worktree`);
  box.git(box.repo, 'worktree', 'add', '-q', path, '-b', branch);
  const joined = box.run(path, 'join', lane);
  assert.equal(joined.code, 0, joined.err);
  return path;
}

test('[L1,L3] an unstaged config edit cannot widen the lane for a staged foreign path', () => {
  const box = project();
  const web = laneWorktree(box, 'web', 'web/one');
  const configPath = join(web, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes.web.owns.push('api/');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(web, 'api', 'bypass.txt'), 'foreign lane file\n');
  box.git(web, 'add', '--', 'api/bypass.txt');

  const refused = box.tryGit(web, 'commit', '-q', '-m', 'feat(web): cross lane policy [G1]');
  assert.notEqual(refused.status, 0, `${refused.stdout}${refused.stderr}`);
  assert.match(refused.stderr, /outside the web lane: api\/bypass\.txt/);
  const committedForeign = box.tryGit(web, 'show', 'HEAD:api/bypass.txt');
  assert.notEqual(committedForeign.status, 0, 'the foreign path never entered HEAD');
  assert.ok(box.git(web, 'status', '--short').includes(' M pullboard.json'), 'the attempted policy widening remains unstaged');
});

test('[L3] a plain auto-committing merge of another lane is refused by the installed pre-merge hook', () => {
  const box = project();
  const web = laneWorktree(box, 'web', 'web/one');
  const api = laneWorktree(box, 'api', 'api/one');
  writeFileSync(join(web, 'web', 'work.txt'), 'web branch change\n');
  box.git(web, 'add', '--', 'web/work.txt');
  box.git(web, 'commit', '-q', '-m', 'feat(web): add lane work [G1]');
  writeFileSync(join(api, 'api', 'foreign-route.txt'), 'api branch change\n');
  box.git(api, 'add', '--', 'api/foreign-route.txt');
  box.git(api, 'commit', '-q', '-m', 'feat(api): add lane route [G2]');

  const webHead = box.git(web, 'rev-parse', 'HEAD');
  const merged = box.tryGit(web, 'merge', 'api/one');
  assert.notEqual(merged.status, 0, `${merged.stdout}${merged.stderr}`);
  assert.match(merged.stderr + merged.stdout, /api\/foreign-route\.txt/);
  assert.match(merged.stderr + merged.stdout, /pre-merge-commit|outside the web lane/i);
  assert.equal(box.git(web, 'rev-parse', 'HEAD'), webHead, 'Git did not create the rejected merge commit');
});

test('[L3] init installs the pre-merge hook and doctor names it when missing', () => {
  const box = project();
  const hook = join(box.repo, '.githooks', 'pre-merge-commit');
  assert.ok(existsSync(hook), 'init installed the merge hook');
  const source = readFileSync(hook, 'utf8');
  assert.match(source, /hook pre-merge-commit/);
  assert.equal(box.run(box.repo, 'doctor', '--json').code, 0, 'the installed hook leaves a clean board');
  rmSync(hook);

  const doctor = box.run(box.repo, 'doctor', '--json');
  assert.equal(doctor.code, 1, `${doctor.out}${doctor.err}`);
  const problems = JSON.parse(doctor.out).problems;
  assert.ok(problems.some(({ message, next }) => `${message} ${next}`.includes('.githooks/pre-merge-commit')),
    `doctor names the missing hook: ${doctor.out}`);
  assert.ok(!existsSync(hook), 'doctor does not repair the missing hook while diagnosing it');
  box.git(box.repo, 'config', '--unset', 'core.hooksPath');
  const defaultHooks = box.run(box.repo, 'doctor', '--json');
  assert.equal(defaultHooks.code, 1, 'a missing hook is also reported at the default Git hook path');
  assert.ok(JSON.parse(defaultHooks.out).problems.some(({ message }) => message.includes('.git/hooks/pre-merge-commit')));
});

test('[L3] a linked worktree refuses lane checks when the common Git directory has grafts', () => {
  const box = project();
  box.git(box.repo, 'commit', '--allow-empty', '-q', '-m', 'chore: create a graft parent');
  const web = laneWorktree(box, 'web', 'web/one');
  const added = box.run(box.repo, 'add', 'web', 'Graft proof', '--specs', 'G1', '--criterion', 'history remains genuine', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(web, 'claim', String(id)).code, 0);
  const item = JSON.parse(box.run(web, 'show', String(id), '--json').out);
  const commonDir = resolve(web, box.git(web, 'rev-parse', '--git-common-dir'));
  const grafts = join(commonDir, 'info', 'grafts');
  const [head, parent] = box.git(box.repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
  assert.ok(parent, 'fixture has a parent for a valid graft entry');
  assert.equal(grafts, join(box.repo, '.git', 'info', 'grafts'), 'the linked worktree uses the common Git directory');
  writeFileSync(grafts, `${head} ${parent}\n`);
  assert.throws(() => submissionPaths(web, item, head), { code: 'GIT_GRAFTS' }, 'submission lane backstops also refuse grafted history');
  writeFileSync(join(web, 'web', 'graft-check.txt'), 'owned path\n');
  box.git(web, 'add', '--', 'web/graft-check.txt');

  const refused = box.tryGit(web, 'commit', '-q', '-m', 'feat(web): check graft state [G1]');
  assert.notEqual(refused.status, 0, `${refused.stdout}${refused.stderr}`);
  assert.match(refused.stderr + refused.stdout, /graft/i);
  assert.match(refused.stderr + refused.stdout, /\.git\/info\/grafts|info\/grafts|grafts/);
  rmSync(grafts);
  const restored = box.tryGit(web, 'commit', '-q', '-m', 'feat(web): commit with genuine history [G1]');
  assert.equal(restored.status, 0, `${restored.stdout}${restored.stderr}`);
});
