/** Real board review guards preserve recorded and declared builder family authority [V1,V4,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { openBoard } from '../apps/lib/index.js';
import * as store from '../packages/store/index.js';
import { reviewEligibility } from '../packages/verify/index.js';
import { reviewBuilderFamily } from '../packages/items/index.js';
import { minimumMoveEngine } from '../packages/moves/index.js';
import { REVIEW_BUILDER_FAMILY_ENGINE } from '../packages/state/index.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';

/** Make a submitted item using actual native claims and a synthetic board-only proof. */
function submitted(board, builder) {
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Declared family review', criterion: 'Prove the change' });
  store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: 3_600_000,
    freeze: () => ({ text: JSON.stringify({ policy: { verify: { policy: 'any', family: 'require' } } }), digest: 'family-test-digest' }) });
  submitFixture(board, id, { agentId: builder, commit: 'a'.repeat(40), tree: 'b'.repeat(40), files: ['src/example.js'] });
  return id;
}

test('a worktree command records the family from the canonical model-tier table [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const created = box.run(box.repo, 'worktree', 'web', '--model', 'claude-sonnet-5-5', '--json');
  assert.equal(created.code, 0, created.err || created.out);
  const result = JSON.parse(created.out);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const seat = store.agentAt(board, result.path);
    assert.equal(seat.agent_model, 'claude-sonnet-5-5');
    assert.equal(seat.agent_family, 'anthropic', 'known model tiers declare their canonical family when the worktree is registered');
  } finally { board.db.close(); }
});

test('an unreported build uses the explicitly declared builder family in review and replay [V1,V4,H16]', t => {
  const board = fixtureBoard(t);
  for (const [id, family, parent] of [['coordinator', 'person-family', 'd'], ['core-1', null, 'a'], ['core-2', 'vendor-a', 'b'], ['core-3', 'vendor-b', 'c']]) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, family, model: 'fixture model', parentDigest: parent.repeat(64) });
  }
  const id = submitted(board, 'core-1');
  const item = store.getItem(board, id);
  assert.equal(item.item_builder_family, null);
  assert.equal(reviewBuilderFamily(board, item), null, 'an undeclared family remains unknown');
  store.register(board, { id: 'core-1', lane: 'core', path: '/fixture/core-1', family: 'vendor-a', model: 'fixture model' });
  assert.equal(reviewBuilderFamily(board, item), 'vendor-a');
  const eligibility = reviewEligibility(board, item, { policy: 'any', familyPolicy: 'require' });
  assert.ok(eligibility.eligible.includes('core-3'));
  assert.ok(!eligibility.eligible.includes('core-2'));
  assert.ok(store.reviewerChecks(board, { agentId: 'core-2', policy: 'any', familyPolicy: 'require' }).familyAllows(item));
  assert.equal(store.reviewerChecks(board, { agentId: 'core-3', policy: 'any', familyPolicy: 'require' }).familyAllows(item), null);
  const options = { agentId: 'core-3', lane: 'core', leaseMs: 3_600_000, policy: 'any', familyPolicy: 'require' };
  assert.ok(minimumMoveEngine('reserveReview', [id, options], board) >= REVIEW_BUILDER_FAMILY_ENGINE);
  assert.ok(minimumMoveEngine('reserveNextReview', [options], board) >= REVIEW_BUILDER_FAMILY_ENGINE);
  assert.ok(minimumMoveEngine('verify', [id, options], board) >= REVIEW_BUILDER_FAMILY_ENGINE);
  board.executionEngineVersion = REVIEW_BUILDER_FAMILY_ENGINE - 1;
  assert.equal(reviewBuilderFamily(board, item), null, 'older moves retain their original unknown family');
  delete board.executionEngineVersion;
  store.reserveReview(board, id, options);
  assert.equal(store.getItem(board, id).item_review_by, 'core-3');
});

test('a recorded submission family snapshot remains authoritative [V4,H16]', t => {
  const board = fixtureBoard(t);
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/fixture/coordinator', family: 'person-family', model: 'fixture model', parentDigest: 'd'.repeat(64) });
  store.register(board, { id: 'core-1', lane: 'core', path: '/fixture/core-1', family: 'vendor-a', model: 'fixture model', parentDigest: 'a'.repeat(64) });
  const id = submitted(board, 'core-1');
  const item = store.getItem(board, id);
  assert.equal(item.item_builder_family, 'vendor-a');
  assert.equal(reviewBuilderFamily(board, item), 'vendor-a');
});
