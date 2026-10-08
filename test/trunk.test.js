/** Branch-name-independent check baselines and lane merge ownership [B34,P2,L3]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { mainPolicy } from '../src/trusted-policy.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEMP_DIRS = [];
const SPEC = '# Trunk fixture\n\n## G · Goals\n- G1 [approved, must] The fixture works. | gate: true\n';

/** Remove isolated fixture repositories after their child processes finish. */
function cleanupFixtures() {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
}

after(cleanupFixtures);

/** Build an offline CLI fixture with private Git identity and machine settings. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-trunk-'));
  TEMP_DIRS.push(dir);
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
    GIT_AUTHOR_NAME: 'Trunk fixture',
    GIT_AUTHOR_EMAIL: 'trunk@example.invalid',
    GIT_COMMITTER_NAME: 'Trunk fixture',
    GIT_COMMITTER_EMAIL: 'trunk@example.invalid',
    PATH: `${bin}:${process.env.PATH}`,
  });
  /** Run isolated Git commands. */
  function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  }
  /** Run a real Pullboard CLI process in the fixture environment. */
  function run(cwd, ...args) {
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', timeout: 30_000 });
    return { code: result.status, out: result.stdout, err: result.stderr };
  }
  return { dir, env, git, run };
}

/** Quote a shell word for the fixture's local Pullboard executable. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Initialize a committed repo whose primary branch has the supplied name. */
function project(branch) {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').code, 0);
  const configPath = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.gate = 'true';
  config.lanes = { web: { owns: ['web/'], specs: ['G1'] } };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'result.txt'), 'ready\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize trunk fixture');
  if (branch !== 'main') box.git(repo, 'branch', '-m', branch);
  return { ...box, repo };
}

for (const branch of ['master', 'trunk']) {
  test(`[B34,P2] add --check captures the ${branch} baseline without a remote`, () => {
    const box = project(branch);
    const head = box.git(box.repo, 'rev-parse', 'HEAD');
    assert.equal(mainPolicy(box.repo).commit, head, 'trusted policy resolves the primary checkout rather than a fixed branch name');
    const added = box.run(box.repo, 'add', 'web', `baseline on ${branch}`, '--specs', 'G1', '--criterion', 'a real check baseline is recorded', '--check', 'node -e "process.exit(1)"', '--json');
    assert.equal(added.code, 0, `${added.out}${added.err}`);
    const item = JSON.parse(added.out).item;
    assert.equal(item.item_check_baseline.main, head, `${branch} baseline points at the primary checkout commit`);
    assert.equal(item.item_check_baseline.result, 'red', `${branch} baseline actually ran instead of being unavailable`);
    assert.notEqual(item.item_check_baseline.reason, 'no main');
  });
}

for (const branch of ['master', 'trunk']) {
  test(`[B34,P2,L3] a lane can resolve an owned conflict while retaining ${branch} files`, () => {
    const box = project(branch);
    const web = join(box.dir, 'web-worktree');
    box.git(box.repo, 'worktree', 'add', '-q', web, '-b', 'web/agent');
    assert.equal(box.run(web, 'join', 'web').code, 0);
    writeFileSync(join(web, 'web', 'result.txt'), `resolved by web lane from ${branch}\n`);
    box.git(web, 'add', 'web/result.txt');
    box.git(web, 'commit', '-q', '-m', 'feat(web): update owned fixture [G1]');
    writeFileSync(join(box.repo, 'web', 'result.txt'), `updated by ${branch}\n`);
    writeFileSync(join(box.repo, 'coordinator.txt'), `owned by ${branch}\n`);
    box.git(box.repo, 'add', 'web/result.txt', 'coordinator.txt');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: update trunk fixture');
    const trunkHead = box.git(box.repo, 'rev-parse', 'HEAD');
    const merged = spawnSync('git', ['merge', '--no-ff', '--no-commit', branch], {
      cwd: web, env: box.env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(merged.status, 1, `${merged.stdout}${merged.stderr}`);
    assert.equal(box.git(web, 'rev-parse', 'MERGE_HEAD'), trunkHead, 'the merge is against the primary checkout tip');
    assert.ok(box.git(web, 'status', '--porcelain').includes('UU web/result.txt'), 'the primary and lane edits conflict on an owned file');
    writeFileSync(join(web, 'web', 'result.txt'), `resolved by web lane from ${branch}\n`);
    box.git(web, 'add', 'web/result.txt');

    const committed = spawnSync('git', ['commit', '-m', `Merge ${branch} into web/agent`], {
      cwd: web, env: box.env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
    assert.equal(box.git(web, 'show', 'HEAD:web/result.txt'), `resolved by web lane from ${branch}`);
    assert.equal(box.git(web, 'show', 'HEAD:coordinator.txt'), `owned by ${branch}`);
    assert.equal(box.git(web, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'the lane committed a two-parent merge');
  });
}

test('[B34,P2] add --check reports an unavailable baseline for a detached coordinator', () => {
  const box = project('master');
  box.git(box.repo, 'checkout', '--detach', '-q', 'HEAD');
  const added = box.run(box.repo, 'add', 'web', 'detached baseline', '--specs', 'G1', '--criterion', 'detached baseline is unavailable', '--check', 'true', '--json');
  assert.equal(added.code, 0, `${added.out}${added.err}`);
  const item = JSON.parse(added.out).item;
  assert.deepEqual(item.item_check_baseline, {
    command: 'true', main: null, result: 'unavailable', reason: 'coordinator checkout is detached',
  });
});
