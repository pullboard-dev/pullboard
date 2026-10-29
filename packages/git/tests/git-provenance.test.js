/** Running source provenance ignores inherited Git hook repository overrides [A5,A6]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  openBoard,
  closeBoard,
  SCHEMA_VERSION,
} from "../../../src/board.js";
import {
  codeIsFromMain,
  withGitFacts,
} from "../src/shell/git.js";

/** Run Git in a disposable fixture without depending on user or system config. */
function git(cwd, args, env) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8' });
}

/** Ask a fresh Node process for source provenance under inherited Git directory variables. */
function probe(moduleURL, root, env) {
  const script = `import { codeIsFromMain } from ${JSON.stringify(moduleURL)}; process.stdout.write(String(codeIsFromMain(process.argv[1])));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout === 'true';
}

test('[A5,A6] code provenance strips inherited GIT_DIR in both worktree-to-main directions', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'pullboard-git-provenance-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const main = join(fixture, 'main');
  const linked = join(fixture, 'linked');
  mkdirSync(main);
  const baseEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Provenance test',
    GIT_AUTHOR_EMAIL: 'provenance@example.test',
    GIT_COMMITTER_NAME: 'Provenance test',
    GIT_COMMITTER_EMAIL: 'provenance@example.test',
  };
  const init = git(main, ['init', '-q', '-b', 'main'], baseEnv);
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  for (const args of [['add', 'README.md'], ['commit', '-q', '-m', 'fixture']]) {
    const result = git(main, args, baseEnv);
    assert.equal(result.status, 0, result.stderr);
  }
  const worktree = git(main, ['worktree', 'add', '-q', '-b', 'feature', linked], baseEnv);
  assert.equal(worktree.status, 0, worktree.stderr);
  const mainGitDir = git(main, ['rev-parse', '--path-format=absolute', '--git-dir'], baseEnv).stdout.trim();
  const linkedGitDir = git(linked, ['rev-parse', '--path-format=absolute', '--git-dir'], baseEnv).stdout.trim();
  const commonGitDir = git(main, ['rev-parse', '--path-format=absolute', '--git-common-dir'], baseEnv).stdout.trim();
  const alias = join(fixture, 'MAIN');
  if (existsSync(alias) && statSync(alias).ino === statSync(main).ino) {
    assert.equal(probe(pathToFileURL(resolve(import.meta.dirname, '../src/shell/git.js')).href, alias, baseEnv), true,
      'a case alias of the primary checkout remains primary on a case-insensitive volume');
  }
  const helperURL = pathToFileURL(resolve(import.meta.dirname, '../src/shell/git.js')).href;

  const worktreeAsMain = probe(helperURL, linked, {
    ...baseEnv, GIT_DIR: mainGitDir, GIT_WORK_TREE: main, GIT_COMMON_DIR: mainGitDir,
  });
  assert.equal(worktreeAsMain, false, 'worktree source remains unmerged when its process inherits main checkout variables');

  const mainAsWorktree = probe(helperURL, main, {
    ...baseEnv, GIT_DIR: linkedGitDir, GIT_WORK_TREE: linked, GIT_COMMON_DIR: commonGitDir,
  });
  assert.equal(mainAsWorktree, true, 'main source can upgrade in a hook that inherits linked-worktree variables');
});

test('[A2,N26,A5,A6] code provenance is cached per request and refreshes for the next request', async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'pullboard-git-provenance-scope-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const main = join(fixture, 'main');
  const linked = join(fixture, 'linked');
  const alias = join(fixture, 'active');
  mkdirSync(main);
  const baseEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Provenance test',
    GIT_AUTHOR_EMAIL: 'provenance@example.test',
    GIT_COMMITTER_NAME: 'Provenance test',
    GIT_COMMITTER_EMAIL: 'provenance@example.test',
  };
  const init = git(main, ['init', '-q', '-b', 'main'], baseEnv);
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  for (const args of [['add', 'README.md'], ['commit', '-q', '-m', 'fixture']]) {
    const result = git(main, args, baseEnv);
    assert.equal(result.status, 0, result.stderr);
  }
  const worktree = git(main, ['worktree', 'add', '-q', '-b', 'feature', linked], baseEnv);
  assert.equal(worktree.status, 0, worktree.stderr);
  symlinkSync(main, alias);

  await withGitFacts(async () => {
    assert.equal(codeIsFromMain(alias), true, 'the primary checkout has main-checkout provenance');
    unlinkSync(alias);
    symlinkSync(linked, alias);
    assert.equal(codeIsFromMain(alias), true, 'one request keeps a consistent provenance fact');
  });

  assert.equal(codeIsFromMain(alias), false, 'the next request recomputes linked-worktree provenance');
  assert.equal(codeIsFromMain(fixture), true, 'a source path outside Git retains released-source provenance');
});

/** A cheaper provenance read retains checkout authority and the persistent schema refusal boundary [A5,A6,C7]. */
test('[A5,A6,C7] one provenance read preserves main branch detached and absent-main authority', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-main-authority-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const primary = join(directory, 'primary');
  const branch = join(directory, 'branch');
  const detached = join(directory, 'detached');
  const released = join(directory, 'released');
  mkdirSync(primary); mkdirSync(released);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Authority fixture', GIT_AUTHOR_EMAIL: 'authority@example.test',
    GIT_COMMITTER_NAME: 'Authority fixture', GIT_COMMITTER_EMAIL: 'authority@example.test' };
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '--allow-empty', '-q', '-m', 'private authority fixture'],
    ['worktree', 'add', '-q', '-b', 'feature', branch], ['worktree', 'add', '-q', '--detach', detached]]) {
    const result = git(primary, args, env);
    assert.equal(result.status, 0, result.stderr);
  }
  const helper = pathToFileURL(resolve(import.meta.dirname, '../src/shell/git.js')).href;
  const cases = [['main', primary, true], ['branch', branch, false], ['detached', detached, false], ['released', released, true]];
  for (const [label, root, expected] of cases) {
    const actual = probe(helper, root, env);
    assert.equal(actual, expected, label + ' checkout authority');
    const file = join(directory, label + '.sqlite');
    const old = new DatabaseSync(file); old.exec('PRAGMA user_version = 0'); old.close();
    if (expected) {
      // @pullboard-board-file migration: actual checkout authority initializes this private schema.
      const board = openBoard(file, undefined, { isMain: actual });
      assert.equal(board.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, label + ' may initialize a throwaway schema');
      closeBoard(board);
    } else {
      // @pullboard-board-file migration: a linked checkout must refuse this persistent private schema.
      assert.throws(() => openBoard(file, undefined, { isMain: actual }), { code: 'UNMERGED_SCHEMA' }, label + ' cannot upgrade persistent schema');
      const unchanged = new DatabaseSync(file, { readOnly: true });
      assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 0, label + ' refusal leaves version unchanged');
      assert.equal(unchanged.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0, label + ' refusal creates no tables');
      unchanged.close();
    }
  }
  const renamed = git(primary, ['branch', '-m', 'without-main'], env);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.notEqual(git(primary, ['show-ref', '--verify', '--quiet', 'refs/heads/main'], env).status, 0);
  assert.equal(probe(helper, primary, env), true, 'primary checkout retains authority when no branch is named main');
  assert.equal(probe(helper, branch, env), false, 'linked branch has no upgrade authority when the main ref is absent');
  assert.equal(probe(helper, detached, env), false, 'linked detached HEAD has no upgrade authority when the main ref is absent');
  // @pullboard-board-file migration: absence of a main ref does not authorize linked schema upgrades.
  for (const label of ['branch', 'detached']) assert.throws(() => openBoard(join(directory, label + '.sqlite'), undefined,
    { isMain: probe(helper, label === 'branch' ? branch : detached, env) }), { code: 'UNMERGED_SCHEMA' }, label + ' still refuses an old schema with no main ref');
});
