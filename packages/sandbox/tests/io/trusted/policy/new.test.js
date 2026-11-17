/** A file an item created before a reclaim stays placeable, while main's own files and other lanes' files do not [L3,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { ownsNewFile } from '../../../../src/io/trusted/policy.js';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** Run git in a real temporary repository with a fixed identity, failing loudly on any Git error. */
function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Commit one file with a message; the message carries the item trailer the lane check reads. */
function commitFile(root, file, message) {
  mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(join(root, file), 'created\n');
  git(root, 'add', file);
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

/** A repository whose main has one file, and a branch where the item (and optionally a foreign lane) adds files. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'owns-new-file-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'base\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

test('sandbox.policy.new.created-file-may-be-placed: an item that created a file before a reclaim may place it while main lacks the file [L3,C7]', () => {
  const root = repo();
  const main = git(root, 'rev-parse', 'main');
  git(root, 'switch', '-q', '-c', 'item');
  const own = commitFile(root, 'src/view/stage.css', 'feat(view): stage [C7]\n\nPullboard-Item: #7');
  // A reclaim moves the claim base to the item's own commit, so the file is no longer absent from the base.
  assert.equal(ownsNewFile(root, { item_id: 7 }, own, main, 'src/view/stage.css'), true);
});

test('sandbox.policy.new.file-on-main-refused: a row for a file present on main is refused even when the item also created it [L3,C7]', () => {
  const root = repo();
  git(root, 'switch', '-q', '-c', 'item');
  const own = commitFile(root, 'src/view/shared.css', 'feat(view): shared [C7]\n\nPullboard-Item: #7');
  git(root, 'switch', '-q', 'main');
  commitFile(root, 'src/view/shared.css', 'feat(view): main has it [C7]');
  const main = git(root, 'rev-parse', 'main');
  assert.equal(ownsNewFile(root, { item_id: 7 }, own, main, 'src/view/shared.css'), false);
});

test('sandbox.policy.new.foreign-commit-refused: a file added by a commit that does not name this item is refused [L3,C7]', () => {
  const root = repo();
  const main = git(root, 'rev-parse', 'main');
  git(root, 'switch', '-q', '-c', 'foreign');
  const foreign = commitFile(root, 'src/view/other.css', 'feat(view): other lane [C7]\n\nPullboard-Item: #9');
  assert.equal(ownsNewFile(root, { item_id: 7 }, foreign, main, 'src/view/other.css'), false);
});
