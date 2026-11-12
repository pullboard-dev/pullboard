/** A claim whose item folder names a removed worktree gets a working folder and is told whether earlier commits wait [C7,#4990]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** File one item in the web lane and return its id. */
function file(box, title) {
  const added = fixtureAdd(box.run, box.repo, 'web', title, '--criterion', 'The item is isolated', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  return JSON.parse(added.out).item.item_id;
}

/** Leave the folder of an item as a removed worktree does: the files and `.git` link stay, the Git directory behind it is gone. */
function goneFolder(box, id, { commit }) {
  const path = `${box.web}-item-${id}`;
  const branch = `web/item-${id}`;
  if (commit) {
    // The earlier commit is made from the joined lane worktree: a seat cannot join inside an item folder.
    box.git(box.web, 'switch', '-q', '-c', branch);
    writeFileSync(join(box.web, 'earlier.txt'), 'ported work\n');
    box.git(box.web, 'add', 'earlier.txt');
    box.git(box.web, 'commit', '-q', '-m', 'earlier work');
    box.git(box.web, 'switch', '-q', '-');
    box.git(box.repo, 'worktree', 'add', '-q', path, branch);
  } else box.git(box.repo, 'worktree', 'add', '-q', '-b', branch, path, 'main');
  const gitdir = box.git(path, 'rev-parse', '--absolute-git-dir');
  rmSync(gitdir, { recursive: true, force: true });
  return path;
}

for (const commit of [true, false]) {
  test(`clause 1: [C7] claiming an item whose folder names a removed worktree yields a working folder and says ${commit ? 'earlier commits wait' : 'nothing waits'}`, t => {
    const helpers = createE2eHelpers();
    t.after(() => helpers.cleanup());
    const box = helpers.project('true');
    const id = file(box, 'stale folder');
    const path = goneFolder(box, id, { commit });
    const claimed = box.run(box.web, 'claim', String(id), '--json');
    assert.equal(claimed.code, 0, claimed.err || claimed.out);
    assert.equal(JSON.parse(claimed.out).itemFolder, path);
    assert.equal(box.git(path, 'branch', '--show-current'), `web/item-${id}`, 'git works in the folder');
    assert.equal(existsSync(join(path, 'earlier.txt')), commit, 'the branch commits are in the new folder');
    assert.match(claimed.err, commit ? /1 earlier commit/u : /nothing waits to be submitted/u);
  });
}
