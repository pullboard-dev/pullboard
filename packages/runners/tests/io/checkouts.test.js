/** @pullboard-test-input source-tree */
/** Warm checkout loans preserve exact trees without carrying writable job Git state [C7,P3]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { borrowWarmCheckout } from '../../index.js';
import { snapshotWarmCheckout } from '../../index.js';
import { recycleWarmCheckout } from '../../index.js';
import { cellSandbox } from '../../../store/tests/fixtures/cell.js';

test('a warm loan moves its worktree and restores source, objects, config and refs before reuse [C7,P3]', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-warm-pool-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'), pool = join(directory, 'pool');
  const box = cellSandbox(t);
  const env = box.env;
  mkdirSync(source);
  box.git(source, 'init', '-q', '-b', 'main');
  writeFileSync(join(source, 'tracked.txt'), 'base source\n');
  box.git(source, 'add', '.'); box.git(source, 'commit', '-qm', 'test: source base');
  const base = box.git(source, 'rev-parse', 'HEAD'), tree = box.git(source, 'rev-parse', 'HEAD^{tree}');
  const lease = { release() {} };
  /** Every protocol observation comes from real Git, with no fabricated compiler or proof result. */
  const sourceGit = async (root, args) => box.git(root, ...args);
  const first = join(directory, 'first'); mkdirSync(first);
  const options = { directory: pool, root: first, commit: base, history: new Set([base]), lease, git: sourceGit, env };
  assert.equal(await borrowWarmCheckout(options), null, 'a cold pool leaves the usual empty checkout for materialization');
  box.git(first, 'init', '-q'); box.git(first, 'fetch', '-q', source, base); box.git(first, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  box.git(first, 'repack', '-ad');
  const handle = snapshotWarmCheckout({ directory: pool, root: first, commit: base, tree, lease });
  const inode = statSync(first).ino;
  writeFileSync(join(first, 'tracked.txt'), 'command mutation\n');
  writeFileSync(join(first, 'command-poison'), 'untracked mutation');
  box.git(first, 'tag', 'command-poison');
  writeFileSync(join(first, '.git', 'config'), '[core]\n hooksPath = /does/not/exist\n worktree = /does/not/exist\n');
  const packs = readdirSync(join(first, '.git', 'objects', 'pack')).filter(file => file.endsWith('.pack'));
  assert.ok(packs.length, 'the corruption probe targets an actual packed object store');
  for (const file of packs) {
    chmodSync(join(first, '.git', 'objects', 'pack', file), 0o600);
    writeFileSync(join(first, '.git', 'objects', 'pack', file), 'command-corrupted objects');
  }
  await recycleWarmCheckout(handle, { lease, git: sourceGit, env });
  assert.equal(existsSync(first), false, 'the old job owns no writable alias of the idle checkout');
  const second = join(directory, 'second'); mkdirSync(second);
  const borrowed = await borrowWarmCheckout({ ...options, root: second });
  assert.equal(borrowed.reusedCommit, base);
  assert.equal(statSync(second).ino, inode, 'warm materialization moves the existing worktree instead of copying its files');
  assert.equal(readFileSync(join(second, 'tracked.txt'), 'utf8'), 'base source\n');
  assert.equal(existsSync(join(second, 'command-poison')), false);
  assert.equal(box.git(second, 'tag', '--list'), '');
  assert.equal(box.git(second, 'rev-parse', 'HEAD^{tree}'), tree);
  assert.equal(box.git(second, 'status', '--porcelain'), '');
  const concurrent = join(directory, 'concurrent'); mkdirSync(concurrent);
  assert.equal(await borrowWarmCheckout({ ...options, root: concurrent }), null, 'an active loan cannot be borrowed twice');
  writeFileSync(join(source, 'tracked.txt'), 'descendant source\n');
  box.git(source, 'add', '.'); box.git(source, 'commit', '-qm', 'test: source descendant');
  const child = box.git(source, 'rev-parse', 'HEAD'), childTree = box.git(source, 'rev-parse', 'HEAD^{tree}');
  box.git(second, 'fetch', '-q', source, child); box.git(second, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  const updated = snapshotWarmCheckout({ directory: pool, root: second, commit: child, tree: childTree, borrowed, lease });
  await recycleWarmCheckout(updated, { lease, git: sourceGit, env });
  const third = join(directory, 'third'); mkdirSync(third);
  const reused = await borrowWarmCheckout({ ...options, root: third, commit: child, history: new Set([base, child]) });
  assert.equal(reused.reusedCommit, child);
  assert.equal(statSync(third).ino, inode);
  assert.equal(readFileSync(join(third, 'tracked.txt'), 'utf8'), 'descendant source\n');
  assert.equal(box.git(third, 'rev-parse', 'HEAD^{tree}'), childTree);
  await recycleWarmCheckout(reused, { lease, git: sourceGit, env });
});
