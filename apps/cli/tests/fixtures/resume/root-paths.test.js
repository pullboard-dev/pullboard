/** init writes its root path into a known set of files, so a cached template can be relocated by rewriting exactly those [C7,#8997]. */
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';
import { releaseFixture } from './release.js';

/**
 * The checked-in contract the relocation slices (#9124, #9121) rewrite from. Each entry is a path relative to the fixture
 * root, with the fixture root's own name standing for any root. If init writes the root path anywhere else, the test
 * below fails and names the file.
 */
export const ROOT_PATH_FILES = Object.freeze([
  'home/projects.json',
  'machine-home/board-writes.jsonl',
  'repo/.claude/settings.json',
  'repo/.git/pullboard/board.sqlite',
  'repo/.git/pullboard/setup-written-files.json',
  'repo/.git/pullboard/trace/2026-11-16.jsonl',
]);

/**
 * Files init writes that carry no root path, and the contract says so: the git hooks resolve the root and the CLI at run
 * time (`git rev-parse`), and the repo git config holds only the relative `core.hooksPath`. A rewrite slice has nothing to do for them.
 */
export const ROOT_FREE_FILES = Object.freeze(['repo/.git/config', 'repo/.githooks/commit-msg', 'repo/.githooks/post-commit', 'repo/.githooks/pre-commit', 'repo/.githooks/pre-merge-commit', 'repo/.githooks/pre-push']);

/** Every regular file under `folder`, as paths relative to `base`; symlinks are not followed (`cli` is a shared copy). */
function filesUnder(folder, base, found = []) {
  let names;
  try { names = readdirSync(folder); } catch { return found; }
  for (const name of names) {
    const path = join(folder, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) filesUnder(path, base, found);
    else if (info.isFile()) found.push(relative(base, path));
  }
  return found;
}

/** The files of one fixture root whose bytes name its root path, spelled as given or resolved. */
function rootBearingFiles(root) {
  const spellings = [...new Set([root, realpathSync(root)])].map(spelling => Buffer.from(spelling));
  return filesUnder(root, root)
    .filter(file => spellings.some(spelling => readFileSync(join(root, file)).includes(spelling)))
    .sort();
}

test('clause 1: the git hooks and the repo git config name no root path [C7,#8997]', t => {
  const { root } = releaseFixture(t);
  const bearing = rootBearingFiles(root);
  for (const file of ROOT_FREE_FILES) {
    assert.ok(filesUnder(root, root).includes(file), `init wrote ${file}`);
    assert.ok(!bearing.includes(file), `${file} names the root path`);
  }
});

test('clause 1: init in two different roots writes the root path into exactly the listed files [C7,#8997]', t => {
  const first = releaseFixture(t), second = releaseFixture(t);
  assert.notEqual(first.root, second.root);
  const one = rootBearingFiles(first.root), two = rootBearingFiles(second.root);
  assert.deepEqual(two, one, 'both roots carry their path in the same files');
  assert.deepEqual(one, [...ROOT_PATH_FILES], 'the files init writes the root path into are the listed set');
});
