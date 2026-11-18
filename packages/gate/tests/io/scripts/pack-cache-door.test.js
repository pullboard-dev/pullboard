/** @pullboard-test-input source-cell packages/gate */
/** A runner holds a packed install keyed on the tree and reuses it [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { createPackCache } from '../../../index.js';

/** A counting packer that writes a tarball named for its call number, standing in for npm pack. */
function setup(t) {
  const root = privateFixtureFiles('pullboard-pack-cache-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = { calls: 0 };
  const pack = (tree, destination) => {
    state.calls += 1;
    const path = join(destination, `pkg-${state.calls}.tgz`);
    writeFileSync(path, `packed ${tree} #${state.calls}`);
    return path;
  };
  return { root, state, pack, folder: join(root, 'cache') };
}

test('gate.io-scripts-pack-cache-door.with-runner-packcache-on-one-tree: clause 1: with runner.packCache on, one tree id packs once and a different id packs again [C7]', async t => {
  const { root, state, pack, folder } = setup(t);
  const cached = createPackCache({ enabled: true, folder, pack });
  const first = await cached('tree-a', '/work/a', join(root, 'out1'));
  const second = await cached('tree-a', '/work/a', join(root, 'out2'));
  assert.equal(state.calls, 1);
  assert.equal(readFileSync(first, 'utf8'), readFileSync(second, 'utf8'));
  await cached('tree-b', '/work/b', join(root, 'out3'));
  assert.equal(state.calls, 2);
});

test('gate.io-scripts-pack-cache-door.the-cache-folder-is-pruned-by: clause 1: the cache folder is pruned by size, oldest first [C7]', async t => {
  const { root, pack, folder } = setup(t);
  const cached = createPackCache({ enabled: true, folder, pack, maxBytes: 40 });
  for (const id of ['t1', 't2', 't3']) await cached(id, `/work/${id}`, join(root, `out-${id}`));
  const left = readdirSync(folder).filter(name => name.endsWith('.tgz'));
  assert.ok(left.length < 3 && left.includes('t3.tgz'), left.join());
});

test('gate.io-scripts-pack-cache-door.with-the-setting-off-every-call: clause 1: with the setting off every call packs [C7]', async t => {
  const { root, state, pack, folder } = setup(t);
  const cached = createPackCache({ folder, pack });
  await cached('tree-a', '/work/a', join(root, 'o1'));
  await cached('tree-a', '/work/a', join(root, 'o2'));
  assert.equal(state.calls, 2);
  assert.deepEqual(readdirSync(root).filter(name => name === 'cache'), []);
});
