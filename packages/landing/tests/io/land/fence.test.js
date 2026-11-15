/** @pullboard-test-input packages/landing/src/io/land/fence.js */
/** A land push carries its gate hop epoch through a fenced git ref, so a stale hop owner cannot move trunk [C7,#8275]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { fenceHop } from '../../../src/io/land/fence.js';
import { hopFenceRef } from '../../../src/io/land/fence.js';
import { pushTrunkThroughFence } from '../../../src/io/land/fence.js';

const ITEM = 7;
const TRUNK = 'refs/heads/main';

/** A bare clone whose trunk sits at the base, and a real repository whose HEAD is one commit past it: the batch tip. */
function landing(t) {
  const repo = cellRepo(t, { real: true });
  const { root: dir } = privateFixtureFiles('pullboard-hop-fence-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git');
  runFixtureGit(['clone', '-q', '--bare', repo.root, remote]);
  repo.put('batch.txt', 'the batch\n');
  const tip = repo.commitAll();
  return { root: repo.root, remote, base: repo.commit, tip, trunk: () => runFixtureGit(['rev-parse', TRUNK], { cwd: remote }) };
}

test('clause 1: a land push carrying a stale hop epoch is refused HOP_FENCED and trunk does not move [C7,#8275]', t => {
  const { root, remote, base, trunk } = landing(t);
  fenceHop(root, { remote, item: ITEM, epoch: 1 });
  // The hop lapsed and a second land job took it at epoch 2, moving the fence.
  const taken = fenceHop(root, { remote, item: ITEM, epoch: 2 });
  assert.throws(() => pushTrunkThroughFence(root, { remote, branch: TRUNK, base, hop: { item: ITEM, epoch: 1 } }), error => {
    assert.equal(error.code, 'HOP_FENCED');
    assert.match(error.message, new RegExp(`epoch 1.*${taken.slice(0, 12)}`, 'u'), 'the refusal names the stale epoch and the fence the remote holds');
    return true;
  });
  assert.equal(trunk(), base, 'trunk did not move');
  assert.equal(runFixtureGit(['rev-parse', hopFenceRef(ITEM)], { cwd: remote }), taken, 'the stale push left the fence with the new owner');
});

test('clause 1: the owner at the current hop epoch pushes trunk from the base to the tip through the fence [C7,#8275]', t => {
  const { root, remote, base, tip, trunk } = landing(t);
  fenceHop(root, { remote, item: ITEM, epoch: 1 });
  fenceHop(root, { remote, item: ITEM, epoch: 2 });
  assert.equal(pushTrunkThroughFence(root, { remote, branch: TRUNK, base, hop: { item: ITEM, epoch: 2 } }).status, 0);
  assert.equal(trunk(), tip);
});

test('clause 1: a stale owner cannot fence its old epoch back over the newer one [C7,#8275]', t => {
  const { root, remote } = landing(t);
  fenceHop(root, { remote, item: ITEM, epoch: 1 });
  const taken = fenceHop(root, { remote, item: ITEM, epoch: 2 });
  assert.throws(() => fenceHop(root, { remote, item: ITEM, epoch: 1 }), { code: 'HOP_FENCED' });
  assert.equal(runFixtureGit(['rev-parse', hopFenceRef(ITEM)], { cwd: remote }), taken);
});

test('clause 1: with no hop (gate.fencedHop off) the land push is the plain push and writes no fence ref [C7,#8275]', t => {
  const { root, remote, base, tip, trunk } = landing(t);
  assert.equal(pushTrunkThroughFence(root, { remote, branch: TRUNK, base }).status, 0);
  assert.equal(trunk(), tip);
  assert.equal(runFixtureGit(['for-each-ref', 'refs/pullboard'], { cwd: remote }), '', 'no fence ref was written');
});
