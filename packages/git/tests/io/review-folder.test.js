/** A detached review worktree at a commit the clone already holds [C7,#3091]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { reviewFolder } from "../../src/io/review-folder.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };

/** Run git in a fixture and return trimmed stdout. */
function inRepo(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A clone with two commits and a remote that does not exist. */
function fixture(t) {
  const dir = privateFixtureFiles('review-folder-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clone = dir;
  inRepo(clone, ['init', '-q']);
  inRepo(clone, ['remote', 'add', 'origin', join(dir, 'missing-remote')]);
  writeFileSync(join(clone, 'a.txt'), 'one\n');
  inRepo(clone, ['add', '.']);
  inRepo(clone, ['commit', '-q', '-m', 'one']);
  const first = inRepo(clone, ['rev-parse', 'HEAD']);
  writeFileSync(join(clone, 'a.txt'), 'two\n');
  inRepo(clone, ['commit', '-qam', 'two']);
  return { dir, clone, first, parent: join(dir, '.reviews') };
}

test('clause 1: a commit already in the clone gets a detached worktree without git fetch [C7,#3091]', (t) => {
  const { clone, first, parent } = fixture(t);
  const { folder, created } = reviewFolder(clone, first, parent);
  assert.equal(created, true);
  assert.equal(inRepo(folder, ['rev-parse', 'HEAD']), first);
  assert.equal(readFileSync(join(folder, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: folder, env: ENV }).status, 1, 'HEAD is detached');
  // The remote does not exist, so any fetch would have failed the call above.
});

test('clause 2: a second call for the same commit reuses that folder instead of creating another [C7,#3091]', (t) => {
  const { clone, first, parent } = fixture(t);
  const one = reviewFolder(clone, first, parent);
  const two = reviewFolder(clone, first, parent);
  assert.equal(two.created, false);
  assert.equal(two.folder, one.folder);
  assert.deepEqual(readdirSync(parent), [first]);
});
