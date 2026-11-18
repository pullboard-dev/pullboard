/** A claim moves the seat's spare checkout to the item folder path and never nests it inside a folder already there [C7,#10784]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { spareFolderPath } from '../../../../src/io/item/folder/spare.js';
import { takeSpareFolder } from '../../../../src/io/item/folder/spare.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';
import { policyRepository } from '../../../../../../packages/store/tests/fixtures/submit.js';

const BRANCH = 'core/item-7';
const CHECKOUT = ['checkout', '-q', '-b', BRANCH, 'main'];

/** A real repository with one commit (its pullboard.json), a seat path and that seat's ready spare checkout beside it. */
function repository(t) {
  const root = privateFixtureFiles('pullboard-spare-nest-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const primary = join(root, 'primary');
  mkdirSync(primary);
  policyRepository(primary);
  const seat = join(root, 'seat');
  const spare = spareFolderPath(seat);
  runFixtureGit(['worktree', 'add', '-q', '--detach', spare, 'main'], { cwd: primary });
  return { root, primary, seat, spare, desired: `${seat}-item-7` };
}

/** Every `.git` entry below a folder, its own top-level `.git` excluded. */
function nestedGitEntries(folder, top = folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    if (entry.name === '.git') return path === join(top, '.git') ? [] : [path];
    return entry.isDirectory() ? nestedGitEntries(path, top) : [];
  });
}

/** The folders kept beside the item folder path when a claim set an existing one aside. */
function keptFolders(root, desired) {
  return readdirSync(root).filter(name => name.startsWith(`${basename(desired)}.prior-`)).map(name => join(root, name));
}

test('cli.item-folder-spare.existing-folder-set-aside: clause 1: when the item folder path already exists, the spare is never moved inside it; the existing folder is kept beside it first and the spare takes the item folder path [C7,#10784]', t => {
  const { root, primary, seat, spare, desired } = repository(t);
  mkdirSync(desired);
  writeFileSync(join(desired, 'left-behind.txt'), 'earlier work\n');
  assert.equal(takeSpareFolder(primary, seat, desired, CHECKOUT), true);
  assert.equal(existsSync(join(desired, basename(spare))), false, 'the spare was moved inside the existing item folder');
  assert.equal(existsSync(spare), false, 'the spare stayed at its own path');
  assert.equal(runFixtureGit(['rev-parse', '--show-toplevel'], { cwd: desired }), desired);
  assert.equal(runFixtureGit(['symbolic-ref', '--short', 'HEAD'], { cwd: desired }), BRANCH);
  const kept = keptFolders(root, desired);
  assert.equal(kept.length, 1, 'the existing folder is kept beside the item folder path');
  assert.equal(readFileSync(join(kept[0], 'left-behind.txt'), 'utf8'), 'earlier work\n');
});

test('cli.item-folder-spare.no-nested-checkout: clause 2: after a claim over an existing checkout at the item folder path, the item folder holds no nested checkout with its own .git [C7,#10784]', t => {
  const { root, primary, seat, desired } = repository(t);
  runFixtureGit(['worktree', 'add', '-q', '-b', 'core/item-old', desired, 'main'], { cwd: primary });
  writeFileSync(join(desired, 'untracked.txt'), 'kept\n');
  assert.equal(takeSpareFolder(primary, seat, desired, CHECKOUT), true);
  assert.deepEqual(nestedGitEntries(desired), []);
  assert.equal(runFixtureGit(['symbolic-ref', '--short', 'HEAD'], { cwd: desired }), BRANCH);
  const kept = keptFolders(root, desired);
  assert.equal(kept.length, 1, 'the existing checkout is kept beside the item folder path');
  // The earlier checkout was moved as a worktree, so it still works and keeps its branch and files.
  assert.equal(runFixtureGit(['symbolic-ref', '--short', 'HEAD'], { cwd: kept[0] }), 'core/item-old');
  assert.equal(readFileSync(join(kept[0], 'untracked.txt'), 'utf8'), 'kept\n');
});

test('cli.item-folder-spare.no-existing-folder-unchanged: clause 3: with no item folder at the path, a claim on a real repository still moves the spare into place unchanged [C7,#10784]', t => {
  const { root, primary, seat, spare, desired } = repository(t);
  assert.equal(takeSpareFolder(primary, seat, desired, CHECKOUT), true);
  assert.equal(existsSync(spare), false, 'the spare left its own path');
  assert.equal(runFixtureGit(['rev-parse', '--show-toplevel'], { cwd: desired }), desired);
  assert.equal(runFixtureGit(['symbolic-ref', '--short', 'HEAD'], { cwd: desired }), BRANCH);
  assert.equal(existsSync(join(desired, 'pullboard.json')), true, 'the tracked file is in place');
  assert.deepEqual(nestedGitEntries(desired), []);
  assert.deepEqual(keptFolders(root, desired), [], 'nothing was set aside');
});
