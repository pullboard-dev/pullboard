/** Real merge hooks prove main integration without weakening lane ownership, on plain checkouts [L3,H16,B26]. */
/** @pullboard-test-input source-cell commits config doctrine spec store */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardBusyError } from "../../store/index.js";
import { openBoardReadOnly } from "../../store/index.js";
import { rowDecisions } from "../../spec/index.js";
import { checkLoosening } from "../index.js";
import { preCommitProblems } from "../../commits/index.js";
import { runFixtureChild } from "../../gate/tests/fixtures/child.js";
import { hookFixtures } from "./fixtures/hooks.js";
import { runFixtureGit } from "../../gate/tests/fixtures/child.js";
import { defaults } from "../../config/index.js";

const { diverge, fixture, git } = hookFixtures({ runFixtureChild, runFixtureGit, defaults });



const approvedRowPorts = { boardBusyError, openBoardReadOnly, rowDecisions, checkLoosening };

test('accepted-main merges preserve exact foreign objects on a primary branch named trunk [L3]', (t) => {
  const box = fixture(t, 'trunk');
  diverge(box);
  assert.deepEqual(preCommitProblems({ ...box.context, approvedRowPorts }), []);
  git(box.lane, 'commit', '-q', '-m', 'test: merge accepted main');
  writeFileSync(join(box.lane, 'view', 'file'), 'outside a merge\n');
  git(box.lane, 'add', '-A');
  assert.ok(preCommitProblems({ ...box.context, approvedRowPorts }).some((problem) => problem.includes('outside the core lane: view/file')),
    'the exception ends when the merge ends');
});

test('owned conflict resolutions commit while foreign edits and mode changes remain refused [L3]', (t) => {
  const box = fixture(t);
  diverge(box, { conflict: true });
  writeFileSync(join(box.lane, 'core', 'file'), 'resolved owned core\n');
  git(box.lane, 'add', 'core/file');
  assert.deepEqual(preCommitProblems({ ...box.context, approvedRowPorts }), []);
  writeFileSync(join(box.lane, 'view', 'file'), 'sneaked foreign edit\n');
  git(box.lane, 'add', 'view/file');
  assert.ok(preCommitProblems({ ...box.context, approvedRowPorts }).some((problem) => problem.includes('view/file')));
  git(box.lane, 'restore', '--source=MERGE_HEAD', '--staged', '--worktree', '--', 'view/file');
  git(box.lane, 'update-index', '--chmod=+x', 'view/file');
  assert.ok(preCommitProblems({ ...box.context, approvedRowPorts }).some((problem) => problem.includes('view/file')),
    'an unchanged blob does not authorize a different executable mode');
});

test('an accepted-main conflict permits a foreign resolution, including literal odd filenames [L3,H16,B26]', (t) => {
  const box = fixture(t);
  const path = 'view/literal [x] \n file';
  writeFileSync(join(box.main, path), 'base literal\n');
  git(box.main, 'add', '-A');
  git(box.main, 'commit', '-q', '-m', 'test: add literal fixture path');
  git(box.lane, 'merge', '--ff-only', 'main');
  writeFileSync(join(box.lane, path), 'existing lane parent\n');
  git(box.lane, 'add', '-A');
  git(box.lane, 'commit', '-q', '-m', 'test: prior foreign parent fixture');
  writeFileSync(join(box.main, path), 'accepted other parent\n');
  git(box.main, 'add', '-A');
  git(box.main, 'commit', '-q', '-m', 'test: alternate accepted parent');
  const result = runFixtureChild('git', ['merge', '--no-commit', '--no-ff', 'main'], { cwd: box.lane, encoding: 'utf8' });
  assert.equal(result.status, 1, result.failure ?? 'foreign parents conflict');
  assert.ok(preCommitProblems({ ...box.context, approvedRowPorts }).some((problem) => problem.includes('literal')),
    'unresolved stages are never treated as an absent path');
  git(box.lane, 'restore', '--source=HEAD', '--staged', '--worktree', '--', path);
  assert.deepEqual(preCommitProblems({ ...box.context, approvedRowPorts }), []);
  writeFileSync(join(box.lane, path), 'neither parent\n');
  git(box.lane, 'add', '--', path);
  assert.deepEqual(preCommitProblems({ ...box.context, approvedRowPorts }), [],
    'a resolved accepted-main conflict may choose new content at its coordinator-owned path');
});

test('merging an unaccepted branch never authorizes foreign changes [L3]', (t) => {
  const box = fixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  git(box.lane, 'add', '-A');
  git(box.lane, 'commit', '-q', '-m', 'test: diverge lane');
  git(box.main, 'branch', 'unaccepted');
  const other = join(box.main, '..', 'other');
  git(box.main, 'worktree', 'add', '-q', other, 'unaccepted');
  writeFileSync(join(other, 'view', 'file'), 'unaccepted foreign\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'test: unaccepted branch');
  git(box.lane, 'merge', '--no-commit', '--no-ff', 'unaccepted');
  assert.ok(preCommitProblems({ ...box.context, approvedRowPorts }).some((problem) => problem.includes('view/file')));
});

// Since #2040 a lane may stage a foreign file exactly as accepted main or the merge base has it (a squash of main), so
// these cases stage foreign content that neither has: only a real merge could authorize it, and a tag is not one.
