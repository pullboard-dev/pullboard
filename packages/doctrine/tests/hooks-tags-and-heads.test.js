/** Installed native hooks refuse tag shortcuts, a hand-written MERGE_HEAD and exact foreign paths [L3]. */
/** @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hookFixtures } from "./fixtures/hooks.js";
import { runFixtureChild } from "../../gate/tests/fixtures/child.js";
import { runFixtureGit } from "../../gate/tests/fixtures/child.js";
import { defaults } from "../../config/index.js";

const { nativeCommit, nativeFixture } = hookFixtures({ runFixtureChild, runFixtureGit, defaults });



test('doctrine.hooks-tags-and-heads.installed-pre-commit-refuses-tag-based: installed pre-commit refuses tag-based foreign edit and deletion shortcuts [L3]', (t) => {
  const edited = nativeFixture(t);
  writeFileSync(join(edited.lane, 'core', 'file'), 'lane core\n');
  let result = edited.git(edited.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(edited, edited.lane);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(edited.main, 'view', 'file'), 'accepted view\n');
  result = edited.git(edited.main, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(edited, edited.main);
  assert.equal(result.status, 0, result.stderr);
  result = edited.git(edited.lane, 'tag', 'MERGE_HEAD', 'main');
  assert.equal(result.status, 0);
  writeFileSync(join(edited.lane, 'view', 'file'), 'builder view\n');
  result = edited.git(edited.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(edited, edited.lane);
  assert.notEqual(result.status, 0, 'a tag cannot authorize a foreign edit');
  assert.match(result.stderr, /outside the core lane: view\/file/u);

  const deleted = nativeFixture(t);
  writeFileSync(join(deleted.lane, 'core', 'file'), 'lane core\n');
  result = deleted.git(deleted.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(deleted, deleted.lane);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(deleted.main, 'view', 'file'), 'accepted view\n');
  result = deleted.git(deleted.main, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(deleted, deleted.main);
  assert.equal(result.status, 0, result.stderr);
  result = deleted.git(deleted.lane, 'tag', 'MERGE_HEAD', 'main');
  assert.equal(result.status, 0);
  unlinkSync(join(deleted.lane, 'view', 'file'));
  result = deleted.git(deleted.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(deleted, deleted.lane);
  assert.notEqual(result.status, 0, 'a tag cannot authorize a foreign deletion');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
});

test('doctrine.hooks-tags-and-heads.installed-pre-commit-refuses-a-hand: installed pre-commit refuses a hand-written MERGE_HEAD already in HEAD [L3]', (t) => {
  const box = nativeFixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  let result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane);
  assert.equal(result.status, 0, result.stderr);
  unlinkSync(join(box.main, 'view', 'file'));
  result = box.git(box.main, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main);
  assert.equal(result.status, 0, result.stderr);
  const deletion = box.git(box.main, 'rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(box.main, 'view', 'file'), 'accepted re-add\n');
  result = box.git(box.main, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main);
  assert.equal(result.status, 0, result.stderr);
  result = box.git(box.lane, 'merge', '--no-commit', '--no-ff', 'main');
  assert.equal(result.status, 0, result.stderr);
  result = nativeCommit(box, box.lane, 'test: merge accepted main');
  assert.equal(result.status, 0, result.stderr);
  const mergeHeadPath = box.git(box.lane, 'rev-parse', '--git-path', 'MERGE_HEAD').stdout.trim();
  writeFileSync(mergeHeadPath, `${deletion}\n`);
  unlinkSync(join(box.lane, 'view', 'file'));
  result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane);
  assert.notEqual(result.status, 0, 'a target already in HEAD cannot authorize a foreign deletion');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
});

test('doctrine.hooks-tags-and-heads.installed-pre-commit-matches-an-exact: installed pre-commit matches an exact foreign path during a merge [L3]', (t) => {
  const box = nativeFixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  let result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(box.main, 'view', 'file'), 'shared blob\n');
  result = box.git(box.main, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main);
  assert.equal(result.status, 0, result.stderr);
  result = box.git(box.lane, 'merge', '--no-commit', '--no-ff', 'main');
  assert.equal(result.status, 0, result.stderr);
  unlinkSync(join(box.lane, 'view', 'file'));
  mkdirSync(join(box.lane, 'view', 'file'));
  writeFileSync(join(box.lane, 'view', 'file', 'x'), 'shared blob\n');
  result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane);
  assert.notEqual(result.status, 0, 'the owned child path cannot impersonate its foreign parent path');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
});
