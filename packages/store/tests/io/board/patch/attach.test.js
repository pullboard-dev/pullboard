import { asSubmitted } from '../../../../../verify/index.js';
import { refuseUnreviewable } from '../../../../../verify/index.js';
/** Real native attachment previews and submit moves share strict ownership authority [V4,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import { heartbeatSeat } from '../../../../index.js';
import { refuseLiveAttach } from '../../../../../items/index.js';
import { reviewEligibility } from '../../../../../verify/index.js';
import { submitPreflight } from '../../../../../items/index.js';
import { submitFixture } from '../../../fixtures/submit.js';
import { exportBoard } from '../../../../index.js';

const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40);
const PATCH = 'diff --git a/x.txt b/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1,4 @@\n+a\n+b\n+c\n+d\n';
const REVIEW = { policy: 'any', familyPolicy: 'require' };

/** Persist distinct native authors and reviewers; optional peers model the exact available families. */
function fixture(t, { independentOpenAI = true } = {}) {
  const board = fixtureBoard(t);
  const seats = [['coordinator', 'coordinator', 'claude', 'a'], ['core-1', 'core', 'claude', 'b'],
    ['core-2', 'core', 'openai', 'c'], ['core-3', 'core', 'openai', 'd']];
  for (const [id, lane, family, parent] of seats) {
    if (!independentOpenAI && id === 'core-3') continue;
    store.register(board, { id, lane, family, path: `/fixture/${id}`, session: parent.repeat(64), parentDigest: parent.repeat(64), model: 'Synthetic fixture model' });
    heartbeatSeat(board, id);
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Claude builder OpenAI companion', sensitive: true });
  const claimed = store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
    freeze: () => ({ text: '{}', digest: 'reverse-composition-fixture' }) });
  const attachment = { key: 'openai-companion', author: 'core-2', commit: COMMIT, patch: PATCH };
  return { board, id, claimed, attachment };
}

test('Claude builder and OpenAI companion use one eligibility rule for live attach, submit and independent verify [V4,H16]', t => {
  const { board, id, claimed, attachment } = fixture(t);
  const before = exportBoard(board);
  assert.doesNotThrow(() => refuseLiveAttach(board, store.getItem(board, id), attachment, { asSubmitted, refuseUnreviewable, atomic: store.atomic, review: REVIEW }));
  assert.deepEqual(exportBoard(board), before, 'live attachment preview records no authority');
  store.attachItemPatch(board, id, { agentId: 'coordinator', ...attachment, presubmit: true });
  assert.doesNotThrow(() => submitPreflight(board, id, { agentId: 'core-1', commit: COMMIT, tree: TREE },
    { atomic: store.atomic, submit: store.submit }, { refuse: (observed, item) => refuseUnreviewable(observed, item, REVIEW) }));
  submitFixture(board, id, { agentId: 'core-1', commit: COMMIT, tree: TREE });
  const projected = reviewEligibility(board, store.getItem(board, id), REVIEW);
  // Since #2889 review uses the builder seat's derived family, so no composition owner is projected at this engine.
  assert.equal(projected.owner, undefined);
  assert.deepEqual(projected.eligible, ['core-3']);
  for (const author of ['core-1', 'core-2']) assert.ok(projected.ineligible.some(row => row.agent === author && row.code === 'SELF_VERIFY'));
  store.verify(board, id, { agentId: 'core-3', decision: 'ACCEPT', head: COMMIT, digest: claimed.digest, companionDigest: store.itemPatchDigest(board, id), ...REVIEW,
    note: 'Synthetic native board-state fixture only; no gate execution claim.' });
  assert.equal(store.getItem(board, id).item_status, 'verified');
});

test('claimed attachment cannot infer future companion ownership from absent submit counts [V4,H16]', t => {
  const { board, id, attachment } = fixture(t, { independentOpenAI: false });
  const before = exportBoard(board);
  assert.throws(() => refuseLiveAttach(board, store.getItem(board, id), attachment, { asSubmitted, refuseUnreviewable, atomic: store.atomic, review: REVIEW }), { code: 'NO_ELIGIBLE_REVIEWER' });
  assert.deepEqual(exportBoard(board), before, 'refused preview preserves exact board bytes');
});
