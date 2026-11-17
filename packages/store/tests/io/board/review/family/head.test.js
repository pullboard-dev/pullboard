/** Strict review judges only the family of the submitted head's builder, never every family in the item's history [V1,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../index.js';
import { fixtureBoard } from '../../../../../../board/tests/fixtures/board.js';
import { heartbeatSeat } from '../../../../../index.js';
import { reviewEligibility } from '../../../../../../verify/index.js';

const SYNTHETIC_MODEL = 'Synthetic fixture model';

const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40);
const freeze = () => ({ text: '{}', digest: 'synthetic-head-family-bar' });
const REVIEW = { policy: 'any', familyPolicy: 'require' };
const PATCH = 'diff --git a/x.txt b/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1,4 @@\n+a\n+b\n+c\n+d\n';

/**
 * A strict item built by an openai head builder (core-1) with a claude companion author (core-2), so its history spans
 * two families; core-3 is openai, core-4 claude and core-6 gemini, all independent sessions.
 */
function fixture(t) {
  const board = fixtureBoard(t);
  const seats = [['coordinator', 'coordinator', undefined, 'f'], ['core-1', 'core', 'openai', 'a'], ['core-2', 'core', 'claude', 'b'],
    ['core-3', 'core', 'openai', 'c'], ['core-4', 'core', 'claude', 'd'], ['core-6', 'core', 'gemini', 'e']];
  for (const [id, lane, family, parent] of seats) {
    store.register(board, { id, lane, path: `/fixture/${id}`, family, parentDigest: parent.repeat(64), session: parent.repeat(64), model: SYNTHETIC_MODEL });
    heartbeatSeat(board, id);
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Head family fixture', sensitive: true });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze });
  store.attachItemPatch(board, id, { agentId: 'coordinator', key: 'companion', commit: COMMIT, patch: PATCH, author: 'core-2', presubmit: true });
  store.submit(board, id, { agentId: 'core-1', commit: COMMIT, tree: TREE, files: [],
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } });
  return { board, id, projection: () => reviewEligibility(board, store.getItem(board, id), REVIEW) };
}

test('store.io-board-review-family-head.an-item-built-across-two-families: clause 1: an item built across two families lists reviewers from every family except the head builder\'s [V1]', t => {
  const f = fixture(t);
  const result = f.projection();
  assert.equal(result.tier, 'strict');
  assert.ok(result.eligible.includes('core-4'), JSON.stringify(result));
  assert.ok(result.eligible.includes('core-6'), JSON.stringify(result));
  assert.ok(!result.eligible.includes('core-3'), JSON.stringify(result));
  store.reserveReview(f.board, f.id, { agentId: 'core-4', leaseMs: 60_000, ...REVIEW });
  assert.equal(store.getItem(f.board, f.id).item_review_by, 'core-4');
});

test('store.io-board-review-family-head.a-reviewer-from-the-head-builder: clause 2: a reviewer from the head builder\'s family is still refused SAME_FAMILY [V1]', t => {
  const f = fixture(t);
  const result = f.projection();
  assert.ok(result.ineligible.some(row => row.agent === 'core-3' && row.code === 'SAME_FAMILY'), JSON.stringify(result));
  assert.throws(() => store.reserveReview(f.board, f.id, { agentId: 'core-3', leaseMs: 60_000, ...REVIEW }), { code: 'SAME_FAMILY' });
});
