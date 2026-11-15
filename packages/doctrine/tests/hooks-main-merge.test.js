/** Installed native hooks let main merge in and name the coordinator on a foreign conflict [H16,B26]. */
/** @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { hookFixtures } from "./fixtures/hooks.js";
import { runFixtureChild } from "../../gate/tests/fixtures/child.js";
import { runFixtureGit } from "../../gate/tests/fixtures/child.js";
import { defaults } from "../../config/index.js";

const { nativeCommit, nativeFixture, stagedCoordinatorPolicyConflict } = hookFixtures({ runFixtureChild, runFixtureGit, defaults });



test("merging main brings in main's own changes outside the lane [H16,B26]", (t) => {
  const box = nativeFixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  let result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane, 'feat(core): update owned file [L3]');
  assert.equal(result.status, 0, result.stderr);

  const mainConfig = { ...box.config, lease: '3h' };
  writeFileSync(join(box.main, 'pullboard.json'), JSON.stringify(mainConfig, null, 2));
  result = box.git(box.main, 'add', 'pullboard.json');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main, 'chore: update main policy');
  assert.equal(result.status, 0, result.stderr);

  result = box.git(box.lane, 'merge', '--no-edit', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.git(box.lane, 'rev-parse', '--verify', 'HEAD^2').status, 0,
    'the automatic merge completed and created a merge commit');
  assert.deepEqual(JSON.parse(readFileSync(join(box.lane, 'pullboard.json'), 'utf8')), mainConfig,
    'the exact policy change from main is present in the lane checkout');
});

test('resolving a foreign main conflict completes the merge and names the coordinator [H16,B26]', (t) => {
  const { box, mainHead } = stagedCoordinatorPolicyConflict(t);
  const result = nativeCommit(box, box.lane, 'chore: resolve accepted coordinator policy');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /the coordinator owns pullboard\.json/u);
  assert.equal(box.git(box.lane, 'rev-parse', 'HEAD^2').stdout.trim(), mainHead,
    'the resolved commit retains the accepted main commit as its second parent');
});

test('a foreign edit beside a resolved main conflict remains refused [H16,B26]', (t) => {
  const { box } = stagedCoordinatorPolicyConflict(t);
  writeFileSync(join(box.lane, 'view', 'file'), 'unrelated foreign edit\n');
  let result = box.git(box.lane, 'add', 'view/file');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane, 'chore: resolve policy with foreign edit');
  assert.notEqual(result.status, 0, 'the conflict exception cannot authorize unrelated foreign content');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
  assert.notEqual(box.git(box.lane, 'rev-parse', '--verify', 'HEAD^2').status, 0,
    'the refused commit did not finish the merge');
});

test('a mode change on a resolved foreign main conflict remains refused [H16,B26]', (t) => {
  const { box } = stagedCoordinatorPolicyConflict(t);
  chmodSync(join(box.lane, 'pullboard.json'), 0o755);
  const staged = box.git(box.lane, 'add', 'pullboard.json');
  assert.equal(staged.status, 0, staged.stderr);
  const result = nativeCommit(box, box.lane, 'chore: resolve policy with mode change');
  assert.notEqual(result.status, 0, 'conflict resolution cannot authorize a new executable mode');
  assert.match(result.stderr, /outside the core lane: pullboard\.json/u);
  assert.notEqual(box.git(box.lane, 'rev-parse', '--verify', 'HEAD^2').status, 0,
    'the refused commit did not finish the merge');
});
