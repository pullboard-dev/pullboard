/** Installed native hooks refuse inherited-main candidates and resolve a removed foreign file [H16,B26]. */
/** @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hookFixtures } from "./fixtures/hooks.js";
import { runFixtureChild } from "../../gate/tests/fixtures/child.js";
import { runFixtureGit } from "../../gate/tests/fixtures/child.js";
import { defaults } from "../../config/index.js";

const { nativeCommit, nativeFixture } = hookFixtures({ runFixtureChild, runFixtureGit, defaults });



test('an inherited main candidate cannot authorize an automatic merge from an unaccepted branch [H16,B26]', (t) => {
  const box = nativeFixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  let result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane, 'feat(core): update owned file [L3]');
  assert.equal(result.status, 0, result.stderr);

  result = box.git(box.main, 'switch', '-c', 'unaccepted');
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(box.main, 'view', 'file'), 'unaccepted foreign\n');
  result = box.git(box.main, 'add', 'view/file');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main, 'chore: change a foreign file');
  assert.equal(result.status, 0, result.stderr);

  result = box.git(box.main, 'switch', 'main');
  assert.equal(result.status, 0, result.stderr);
  const mainConfig = { ...box.config, lease: '3h' };
  writeFileSync(join(box.main, 'pullboard.json'), JSON.stringify(mainConfig, null, 2));
  result = box.git(box.main, 'add', 'pullboard.json');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main, 'chore: update main policy');
  assert.equal(result.status, 0, result.stderr);
  const mainHead = box.git(box.main, 'rev-parse', 'HEAD').stdout.trim();
  box.env[`GITHEAD_${mainHead}`] = 'main';

  result = box.git(box.lane, 'merge', '--no-edit', 'unaccepted');
  assert.notEqual(result.status, 0, 'the lane hook refuses the real unaccepted merge head');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
  assert.notEqual(box.git(box.lane, 'rev-parse', '--verify', 'HEAD^2').status, 0,
    'the refused merge did not create a merge commit');
});

test('an inherited main candidate cannot authorize an ordinary foreign commit [H16,B26]', (t) => {
  const box = nativeFixture(t);
  const mainConfig = { ...box.config, lease: '3h' };
  writeFileSync(join(box.main, 'pullboard.json'), JSON.stringify(mainConfig, null, 2));
  let result = box.git(box.main, 'add', 'pullboard.json');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main, 'chore: update main policy');
  assert.equal(result.status, 0, result.stderr);
  const mainHead = box.git(box.main, 'rev-parse', 'HEAD').stdout.trim();
  box.env[`GITHEAD_${mainHead}`] = 'main';

  writeFileSync(join(box.lane, 'view', 'file'), 'sneaked foreign edit\n');
  result = box.git(box.lane, 'add', 'view/file');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane, 'chore: stage a foreign edit');
  assert.notEqual(result.status, 0, 'the ordinary pre-commit hook ignores GITHEAD candidates');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
});

test('removing a conflicted foreign file resolves a main merge and names the coordinator [H16,B26]', (t) => {
  const box = nativeFixture(t);
  let result = box.git(box.main, 'switch', '-c', 'historical-view');
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(box.main, 'view', 'file'), 'historical view\n');
  assert.equal(box.git(box.main, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.main, 'chore: retain historical view file');
  assert.equal(result.status, 0, result.stderr);
  result = box.git(box.lane, 'reset', '--hard', 'historical-view');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.git(box.main, 'switch', 'main').status, 0);
  writeFileSync(join(box.main, 'view', 'file'), 'current view\n');
  assert.equal(box.git(box.main, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.main, 'chore: update the view file on main');
  assert.equal(result.status, 0, result.stderr);
  const mainHead = box.git(box.main, 'rev-parse', 'HEAD').stdout.trim();

  result = box.git(box.lane, 'merge', '--no-edit', 'main');
  assert.equal(result.status, 1, 'the fixture must create a real conflict in a foreign file');
  assert.match(box.git(box.lane, 'ls-files', '--unmerged').stdout, /view\/file/u);
  assert.equal(box.git(box.lane, 'rm', '-q', 'view/file').status, 0);
  result = nativeCommit(box, box.lane, 'chore: resolve the view conflict by removing it');
  assert.equal(result.status, 0, `removing the conflicted file is a resolution, not a foreign edit: ${result.stderr}`);
  assert.match(result.stderr, /the coordinator owns view\/file/u, 'the resolution names the coordinator as the owner');
  assert.equal(box.git(box.lane, 'rev-parse', 'HEAD^2').stdout.trim(), mainHead, 'the merge completed with main as its second parent');

  // Outside a conflict, writing the foreign file again is still the lane touching it.
  mkdirSync(join(box.lane, 'view'), { recursive: true });
  writeFileSync(join(box.lane, 'view', 'file'), 'lane rewrite\n');
  assert.equal(box.git(box.lane, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.lane, 'chore: rewrite a foreign file');
  assert.notEqual(result.status, 0, 'a foreign edit with no conflict stays refused');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
});
