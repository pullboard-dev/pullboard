/** Checkout authority from the git cell decides which boards may upgrade a persistent schema [A5,A6,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
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
  closeBoard,
  SCHEMA_VERSION,
} from "../../../packages/store/index.js";
import { openBoard } from "../index.js";

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
  const helper = pathToFileURL(resolve(import.meta.dirname, '../../../packages/git/index.js')).href;
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
