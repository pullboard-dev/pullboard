/** The landing record carries the tree id main will point to: RFC 0011 ET1, narrowed and approved 17 Nov 2026 [V16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { save } from '../../../src/io/step/merge.js';
import { validateLandingBatch } from '../../../../items/index.js';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';

/** A real repository with a base commit and an item commit on top; each commit's tree differs. */
function repository(t) {
  const { root, put } = fixture(t);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  put('web/item.txt', 'item 7\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feat: item 7');
  const tip = git(root, 'rev-parse', 'HEAD').trim();
  const treeOf = commit => git(root, 'rev-parse', `${commit}^{tree}`).trim();
  return { root, base, tip, treeOf };
}

/** A landing state whose board write validates the batch as the store does and records it as the next revision. */
function landingState(root, base) {
  const batch = { version: 1, id: 'batch-7', state: 'merging', base, tip: base, root, branch: 'refs/heads/main',
    items: [], owner: 'coordinator', logPath: '/dev/null', conflicts: [], resolutions: [], revision: 0 };
  const writes = [];
  const write = async (name, [{ batch: next, revision }]) => {
    assert.equal(name, 'recordLandingBatch');
    validateLandingBatch(next, revision);
    writes.push(next);
    return { ...next, revision: revision + 1 };
  };
  return { state: { batch, write }, writes };
}

test('landing.exact.record-carries-the-tip-tree: clause 1: every landing batch revision carries exactTree.tree, the tree id of its tip, and follows the tip when it moves [V16]', async t => {
  const { root, base, tip, treeOf } = repository(t);
  const { state, writes } = landingState(root, base);
  await save(state, { state: 'merging' });
  assert.equal(state.batch.exactTree.tree, treeOf(base), 'the first revision names the tree of the tip it holds');
  await save(state, { state: 'gating', tip });
  assert.equal(state.batch.exactTree.tree, treeOf(tip), 'a revision on a new tip names that tip\'s tree, the tree main will point to');
  assert.notEqual(treeOf(tip), treeOf(base));
  await save(state, { state: 'ready' });
  assert.equal(state.batch.exactTree.tree, treeOf(tip), 'a later revision on the same tip keeps the same tree id');
  assert.ok(writes.every(batch => /^[a-f0-9]{40,64}$/u.test(batch.exactTree?.tree ?? '')), 'every recorded revision carries a full tree id');
});

test('landing.exact.record-refuses-a-malformed-tree: clause 2: validateLandingBatch refuses LAND_BATCH for an exact-tree record without a full tree id, and a batch with no record still validates [V16]', t => {
  const { root, base, treeOf } = repository(t);
  const batch = { version: 1, id: 'batch-7', state: 'merging', base, tip: base, root, branch: 'refs/heads/main',
    items: [], owner: 'coordinator', logPath: '/dev/null' };
  assert.doesNotThrow(() => validateLandingBatch(batch, 0), 'a batch recorded before the exact-tree record existed still validates');
  assert.doesNotThrow(() => validateLandingBatch({ ...batch, exactTree: { tree: treeOf(base) } }, 0));
  for (const exactTree of [{ tree: treeOf(base).slice(0, 12) }, { tree: 'HEAD' }, {}, null, 'tree']) {
    assert.throws(() => validateLandingBatch({ ...batch, exactTree }, 0), error => error.code === 'LAND_BATCH', JSON.stringify(exactTree));
  }
});
