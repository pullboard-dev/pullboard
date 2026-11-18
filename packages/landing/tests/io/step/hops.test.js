/** @pullboard-test-input packages/landing/src/io/step/publish.js */
/** @pullboard-test-input packages/landing/src/io/land/fence.js */
/** Publish saves each item's hop epoch on the landing batch before it pushes trunk through the fences [C7,#8326]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { pushCarryingHops } from '../../../src/io/step/publish.js';
import { hopFenceRef } from '../../../src/io/land/fence.js';
import { gateHopMove } from '../../../../store/index.js';

const ITEM = 7;
const TRUNK = 'refs/heads/main';

/**
 * A bare remote at the base, a repository one commit past it, a board whose gate row for ITEM was taken `epochs` times,
 * and the publish state over them: its board write records each saved batch with the fence ref the remote held then.
 */
function landing(t, { epochs, hops }) {
  const repo = cellRepo(t, { real: true });
  const { root: dir } = privateFixtureFiles('pullboard-publish-hops-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git');
  runFixtureGit(['clone', '-q', '--bare', repo.root, remote]);
  const base = repo.commit;
  repo.put('batch.txt', 'the batch\n');
  const tip = repo.commitAll();
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (let epoch = 1; epoch <= epochs; epoch++) {
    gateHopMove(db, { item: ITEM, enabled: true, decide: () => ({ hop: { state: 'driven', owner: `driver-${epoch}`, epoch, leaseUntil: 0, attempts: epoch, commit: 'c0ffee', digest: 'd1' } }) });
  }
  const fence = () => runFixtureGit(['for-each-ref', '--format=%(objectname)', hopFenceRef(ITEM)], { cwd: remote });
  const saves = [];
  const batch = { id: 1, items: [{ id: ITEM }], branch: TRUNK, base, tip, revision: 0, ...(hops ? { hops } : {}) };
  const state = {
    board: { db }, batch, checkLeaseNow: () => {},
    write: async (name, [{ batch: saved, revision }]) => { saves.push({ name, hops: saved.hops, fenceAtSave: fence() }); return { ...saved, revision: revision + 1 }; },
  };
  return { root: repo.root, remote, tip, state, saves, fence, trunk: () => runFixtureGit(['rev-parse', TRUNK], { cwd: remote }) };
}

test('landing.hops.with-gate-fencedhop-on-publish-saves: clause 2: with gate.fencedHop on, publish saves each item epoch on the batch before it pushes trunk [C7,#8326]', async t => {
  const { root, remote, tip, state, saves, fence, trunk } = landing(t, { epochs: 3 });
  const saved = await pushCarryingHops(state, state.batch, { pushRoot: root, remote, enabled: true });
  assert.deepEqual(saves.map(each => [each.name, each.hops]), [['recordLandingBatch', [{ item: ITEM, epoch: 3 }]]], 'the batch was saved once, carrying the gate row epoch');
  assert.equal(saves[0].fenceAtSave, '', 'the save came before the push: the remote held no fence yet');
  assert.deepEqual(saved.hops, [{ item: ITEM, epoch: 3 }]);
  assert.equal(trunk(), tip, 'trunk moved to the batch tip');
  assert.notEqual(fence(), '', 'the push moved the fence to the carried epoch');
});

test('landing.hops.a-resumed-batch-that-already-carries: clause 2: a resumed batch that already carries its epochs pushes under them without saving again [C7,#8326]', async t => {
  const { root, remote, tip, state, saves, trunk } = landing(t, { epochs: 2, hops: [{ item: ITEM, epoch: 2 }] });
  const saved = await pushCarryingHops(state, state.batch, { pushRoot: root, remote, enabled: true });
  assert.deepEqual(saves, [], 'no second save');
  assert.deepEqual(saved.hops, [{ item: ITEM, epoch: 2 }]);
  assert.equal(trunk(), tip);
});

test('landing.hops.with-gate-fencedhop-off-publish-saves: clause 2: with gate.fencedHop off, publish saves no epochs and makes the plain push [C7,#8326]', async t => {
  const { root, remote, tip, state, saves, fence, trunk } = landing(t, { epochs: 2 });
  await pushCarryingHops(state, state.batch, { pushRoot: root, remote, enabled: false });
  assert.deepEqual(saves, [], 'nothing is saved with the setting off');
  assert.equal(trunk(), tip);
  assert.equal(fence(), '', 'no fence ref was written');
});
