/** Installed native hooks accept main's adds, deletes and renames and a kept side of a foreign conflict [H16,B26]. */
/** @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hookFixtures } from "./fixtures/hooks.js";
import { runFixtureChild } from "../../gate/tests/fixtures/child.js";
import { runFixtureGit } from "../../gate/tests/fixtures/child.js";
import { defaults } from "../../config/index.js";

const { nativeCommit, nativeFixture } = hookFixtures({ runFixtureChild, runFixtureGit, defaults });



test("merging main brings in the foreign files main added, deleted and renamed [H16,B26]", (t) => {
  const box = nativeFixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  assert.equal(box.git(box.lane, 'add', '-A').status, 0);
  let result = nativeCommit(box, box.lane, 'feat(core): update owned file [L3]');
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(box.main, 'view', 'added'), 'added on main\n');
  assert.equal(box.git(box.main, 'add', 'view/added').status, 0);
  assert.equal(box.git(box.main, 'mv', 'view/file', 'view/moved').status, 0);
  result = nativeCommit(box, box.main, 'chore: add and rename view files on main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.git(box.main, 'rm', '-q', 'view/added').status, 0);
  result = nativeCommit(box, box.main, 'chore: delete a view file on main');
  assert.equal(result.status, 0, result.stderr);

  result = box.git(box.lane, 'merge', '--no-edit', 'main');
  assert.equal(result.status, 0, `main's own additions, deletions and renames merge: ${result.stderr}`);
  assert.equal(box.git(box.lane, 'rev-parse', '--verify', 'HEAD^2').status, 0, 'the merge completed');
  assert.equal(readFileSync(join(box.lane, 'view', 'moved'), 'utf8').length > 0, true, "main's rename arrived");
});

test('keeping this side of a conflicted foreign file resolves a main merge [H16,B26]', (t) => {
  const box = nativeFixture(t);
  let result = box.git(box.main, 'switch', '-c', 'historical-view');
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(box.main, 'view', 'file'), 'historical view\n');
  assert.equal(box.git(box.main, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.main, 'chore: retain historical view file');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.git(box.lane, 'reset', '--hard', 'historical-view').status, 0);
  assert.equal(box.git(box.main, 'switch', 'main').status, 0);
  writeFileSync(join(box.main, 'view', 'file'), 'current view\n');
  assert.equal(box.git(box.main, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.main, 'chore: update the view file on main');
  assert.equal(result.status, 0, result.stderr);

  result = box.git(box.lane, 'merge', '--no-edit', 'main');
  assert.equal(result.status, 1, 'the fixture must create a real conflict in a foreign file');
  assert.equal(box.git(box.lane, 'checkout', '--ours', '--', 'view/file').status, 0);
  assert.equal(box.git(box.lane, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.lane, 'chore: keep this side of the view conflict');
  assert.equal(result.status, 0, `keeping one side is a resolution: ${result.stderr}`);
  assert.match(result.stderr, /the coordinator owns view\/file/u);

  // Renaming a conflicted file to a name main never had is the worktree's own new path, refused with its owner named.
  assert.equal(box.git(box.lane, 'mv', 'view/file', 'view/renamed').status, 0);
  result = nativeCommit(box, box.lane, 'chore: rename a foreign file');
  assert.notEqual(result.status, 0, 'a new foreign path the worktree creates stays refused');
  assert.match(result.stderr, /outside the core lane: view\/renamed \(\w+'s\)/u, 'the refusal names the new path and its owner');
});
