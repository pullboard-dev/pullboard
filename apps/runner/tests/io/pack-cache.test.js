/** @pullboard-test-input source-cell apps/runner */
/** A runner holds a packed install keyed on the tree and reuses it [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { createPackCache } from '../../src/io/pack-cache.js';

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

test('clause 1: with runner.packCache on, one tree id packs once and a different id packs again [C7]', t => {
  const { root, state, pack, folder } = setup(t);
  const cached = createPackCache({ enabled: true, folder, pack });
  const first = cached('tree-a', '/work/a', join(root, 'out1'));
  const second = cached('tree-a', '/work/a', join(root, 'out2'));
  assert.equal(state.calls, 1);
  assert.equal(readFileSync(first, 'utf8'), readFileSync(second, 'utf8'));
  cached('tree-b', '/work/b', join(root, 'out3'));
  assert.equal(state.calls, 2);
});

test('clause 1: the cache folder is pruned by size, oldest first [C7]', t => {
  const { root, pack, folder } = setup(t);
  const cached = createPackCache({ enabled: true, folder, pack, maxBytes: 40 });
  for (const id of ['t1', 't2', 't3']) cached(id, `/work/${id}`, join(root, `out-${id}`));
  const left = readdirSync(folder).filter(name => name.endsWith('.tgz'));
  assert.ok(left.length < 3 && left.includes('t3.tgz'), left.join());
});

test('clause 2: with the setting off every call packs [C7]', t => {
  const { root, state, pack, folder } = setup(t);
  const cached = createPackCache({ folder, pack });
  cached('tree-a', '/work/a', join(root, 'o1'));
  cached('tree-a', '/work/a', join(root, 'o2'));
  assert.equal(state.calls, 2);
  assert.deepEqual(readdirSync(root).filter(name => name === 'cache'), []);
});
