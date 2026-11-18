/** A claim moves the seat's spare checkout to the item folder path and never nests it inside a folder already there [C7,#10784], and counts the index without launching Git [C7,#10864]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPARE_FROM_FILES } from '../../../../src/io/item/folder/spare.js';
import { indexEntries } from '../../../../src/io/item/folder/spare.js';
import { prepareSpareFolder } from '../../../../src/io/item/folder/spare.js';
import { enterGitAdapter } from '../../../../../../packages/git/index.js';
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

const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec'];

/**
 * Run `work` while every git launch this process makes is counted; the count comes back with the result.
 * Why both seams: node:child_process sees a launch made by the real Git adapter, and a call chain that selected another
 * adapter (the store fixtures do) never reaches it, so the chain's adapter is replaced by one that counts and launches real Git.
 */
function countingGit(work) {
  const real = Object.fromEntries(APIS.map(api => [api, childProcess[api]]));
  let launches = 0;
  let counting = true;
  for (const api of APIS) {
    childProcess[api] = function counted(...args) {
      if (counting && (typeof args[0] === 'string' ? args[0].trim().split(/\s+/u)[0] : '').endsWith('git')) launches++;
      return real[api].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  enterGitAdapter({
    spawnSync(args, options) { if (counting) launches++; return real.spawnSync('git', args, options); },
    execFileSync(args, options) { if (counting) launches++; return real.execFileSync('git', args, options); },
    spawn(args, options) { if (counting) launches++; return real.spawn('git', args, options); },
  });
  try { const result = work();
    return { launches, result }; } finally {
    counting = false;
    for (const api of APIS) childProcess[api] = real[api];
    syncBuiltinESMExports();
  }
}

/** A primary checkout and a linked worktree of it, tracking `files` extra files on top of pullboard.json. */
function sized(t, files) {
  const { root, primary } = repository(t);
  if (files > 0) {
    mkdirSync(join(primary, 'many'));
    for (let n = 0; n < files; n++) writeFileSync(join(primary, 'many', `f${n}.txt`), `${n}\n`);
    runFixtureGit(['add', '-A'], { cwd: primary });
    runFixtureGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'many files'], { cwd: primary });
  }
  const linked = join(root, 'linked');
  runFixtureGit(['worktree', 'add', '-q', '--detach', linked, 'main'], { cwd: primary });
  return { primary, linked, tracked: Number(runFixtureGit(['ls-files'], { cwd: primary }).split('\n').length) };
}

test('cli.item-folder-spare.index-count-without-git: clause 1: with next.oneGitRead at its default the index entry count is read without launching git, for a primary checkout and a linked worktree, and a spare is due exactly when the count reaches the threshold [C7,#10864]', async t => {
  const small = sized(t, 0);
  const large = sized(t, SPARE_FROM_FILES);
  for (const [name, root, tracked] of [['small primary', small.primary, small.tracked], ['small linked', small.linked, small.tracked], ['large primary', large.primary, large.tracked], ['large linked', large.linked, large.tracked]]) {
    const { launches, result } = countingGit(() => indexEntries(root));
    assert.equal(launches, 0, `${name}: no git process`);
    assert.equal(result, tracked, `${name}: the entries Git lists`);
  }
  assert.ok(indexEntries(large.primary) >= SPARE_FROM_FILES && indexEntries(small.primary) < SPARE_FROM_FILES, 'the threshold splits the two repositories as before');
  const seat = join(small.primary, '..', 'small-seat');
  const { launches, result } = countingGit(() => prepareSpareFolder(small.primary, seat, 'main'));
  assert.equal(await result, false, 'a small repository starts no spare');
  assert.equal(launches, 0, 'and launches no git process deciding so');
  assert.equal(existsSync(spareFolderPath(seat)), false);
});

test('cli.item-folder-spare.index-count-git-fallback: clause 2: a checkout whose repository files cannot answer the index path (a reftable layout) still counts its index through git [C7,#10864]', t => {
  const { primary, tracked } = sized(t, 0);
  // A reftable directory is a layout the file reader leaves to Git; the stray directory does not change how Git itself reads refs or the index.
  mkdirSync(join(primary, '.git', 'reftable'));
  {
    const { launches, result } = countingGit(() => indexEntries(primary));
    assert.ok(launches >= 1, 'git answered the index path');
    assert.equal(result, tracked, 'the count is the same');
  }
});
