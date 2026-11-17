/** @pullboard-test-input source-cell packages/gate */
/**
 * A runner holds an installed prefix keyed on the tree and copies it instead of installing again [C7].
 * The cache is off by default and only tests call it, so it has no setting of its own.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { createInstallCache } from '../../../index.js';

/** A counting installer that writes a small prefix with a relative bin link, standing in for npm install. */
function setup(t) {
  const root = privateFixtureFiles('pullboard-install-cache-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = { calls: 0 };
  const install = (tarball, prefix) => {
    state.calls += 1;
    mkdirSync(join(prefix, 'lib', 'node_modules', 'pullboard'), { recursive: true });
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    writeFileSync(join(prefix, 'lib', 'node_modules', 'pullboard', 'cli.js'), `installed ${tarball} #${state.calls}`);
    symlinkSync('../lib/node_modules/pullboard/cli.js', join(prefix, 'bin', 'pullboard'));
  };
  return { root, state, install, folder: join(root, 'cache') };
}

test('gate.io-scripts-install-cache-door.with-the-cache-on-one-tree: clause 1: with the cache on, one tree id installs once and the next call copies the prefix [C7]', async t => {
  const { root, state, install, folder } = setup(t);
  const cached = createInstallCache({ enabled: true, folder, install });
  const first = join(root, 'p1');
  const second = join(root, 'p2');
  await cached('tree-a', '/work/a.tgz', first);
  await cached('tree-a', '/work/a.tgz', second);
  assert.equal(state.calls, 1);
  assert.equal(readFileSync(join(first, 'bin', 'pullboard'), 'utf8'), readFileSync(join(second, 'bin', 'pullboard'), 'utf8'));
  assert.ok(lstatSync(join(second, 'bin', 'pullboard')).isSymbolicLink(), 'the copied bin is still a link');
  assert.ok(existsSync(join(second, 'bin', 'pullboard')), 'the copied bin link still resolves inside the copy');
  assert.deepEqual(readdirSync(folder), ['tree-a.prefix']);
});

test('gate.io-scripts-install-cache-door.a-different-tree-id-installs-again: clause 2: a different tree id installs again [C7]', async t => {
  const { root, state, install, folder } = setup(t);
  const cached = createInstallCache({ enabled: true, folder, install });
  await cached('tree-a', '/work/a.tgz', join(root, 'p1'));
  await cached('tree-b', '/work/b.tgz', join(root, 'p2'));
  assert.equal(state.calls, 2);
  assert.match(readFileSync(join(root, 'p2', 'bin', 'pullboard'), 'utf8'), /b\.tgz/u);
});

test('gate.io-scripts-install-cache-door.the-cache-folder-is-pruned-by: clause 2: the cache folder is pruned by size, oldest first [C7]', async t => {
  const { root, install, folder } = setup(t);
  const cached = createInstallCache({ enabled: true, folder, install, maxBytes: 120 });
  for (const [index, id] of ['t1', 't2', 't3'].entries()) {
    await cached(id, `/work/${id}.tgz`, join(root, `out-${id}`));
    const when = new Date(Date.now() - (3 - index) * 60_000);
    if (existsSync(join(folder, `${id}.prefix`))) utimesSync(join(folder, `${id}.prefix`), when, when);
  }
  const left = readdirSync(folder);
  assert.ok(left.length < 3 && left.includes('t3.prefix') && !left.includes('t1.prefix'), left.join());
});

test('gate.io-scripts-install-cache-door.with-the-cache-off-every-call: clause 1: with the cache off every call installs and leaves no cache folder [C7]', async t => {
  const { root, state, install, folder } = setup(t);
  const cached = createInstallCache({ folder, install });
  await cached('tree-a', '/work/a.tgz', join(root, 'p1'));
  await cached('tree-a', '/work/a.tgz', join(root, 'p2'));
  assert.equal(state.calls, 2);
  assert.equal(existsSync(folder), false);
});
