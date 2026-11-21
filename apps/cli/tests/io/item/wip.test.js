/** snapshotWip keeps an item folder's work on a board ref without touching the builder's index [C7,#12568]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { snapshotWip } from '../../../src/io/item/wip.js';
import { wipRef } from '../../../src/io/item/wip.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { policyRepository } from '../../../../../packages/store/tests/fixtures/submit.js';

/** A folder with one tracked file at HEAD, plus staged, unstaged and untracked changes. */
function dirtyFolder(t) {
  const root = privateFixtureFiles('pullboard-item-wip-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'folder');
  mkdirSync(folder);
  policyRepository(folder);
  const git = (...args) => runFixtureGit(args, { cwd: folder });
  writeFileSync(join(folder, 'tracked.txt'), 'one\n');
  git('add', 'tracked.txt');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=F', '-c', 'user.email=f@example.test', 'commit', '-q', '-m', 'tracked');
  writeFileSync(join(folder, 'staged.txt'), 'staged\n');
  git('add', 'staged.txt');
  writeFileSync(join(folder, 'tracked.txt'), 'one\nunstaged\n');
  writeFileSync(join(folder, 'untracked.txt'), 'untracked\n');
  return { folder, git };
}

/** What the builder sees of the folder: index bytes and mtime, HEAD and status. */
function builderState(folder, git) {
  const index = join(folder, '.git', 'index');
  return { bytes: readFileSync(index).toString('hex'), mtime: statSync(index).mtimeMs, head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain=v1') };
}

test('cli.io-item-wip.snapshot-keeps-builder-state: clause 1: snapshotWip saves staged, unstaged and untracked work to refs/pullboard/wip/<item> and leaves index, HEAD and status unchanged [C7,#12568]', t => {
  const { folder, git } = dirtyFolder(t);
  const before = builderState(folder, git);
  const first = snapshotWip(folder, 12596);
  assert.equal(first.written, true);
  assert.deepEqual(builderState(folder, git), before);
  assert.equal(git('rev-parse', wipRef(12596)), first.commit);
  assert.equal(git('show', `${first.commit}:staged.txt`), 'staged');
  assert.equal(git('show', `${first.commit}:tracked.txt`), 'one\nunstaged');
  assert.equal(git('show', `${first.commit}:untracked.txt`), 'untracked');
  writeFileSync(join(folder, 'untracked.txt'), 'changed\n');
  const second = snapshotWip(folder, 12596);
  assert.equal(second.written, true);
  assert.equal(git('rev-parse', `${second.commit}^`), first.commit);
  assert.equal(builderState(folder, git).bytes, before.bytes);
});

test('cli.io-item-wip.snapshot-skips: clause 2: an unchanged folder writes no new snapshot and none runs while index.lock exists [C7,#12568]', t => {
  const { folder, git } = dirtyFolder(t);
  const first = snapshotWip(folder, 7);
  const again = snapshotWip(folder, 7);
  assert.deepEqual([again.written, again.reason, again.commit], [false, 'unchanged', first.commit]);
  writeFileSync(join(folder, 'untracked.txt'), 'changed\n');
  const lock = join(folder, '.git', 'index.lock');
  writeFileSync(lock, '');
  const locked = snapshotWip(folder, 7);
  assert.deepEqual([locked.written, locked.reason], [false, 'locked']);
  assert.equal(git('rev-parse', wipRef(7)), first.commit);
  rmSync(lock);
  assert.equal(snapshotWip(folder, 7).written, true);
});
