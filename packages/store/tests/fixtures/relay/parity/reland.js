/** Selector gaps and accepted relands pass the complete native/relay reader oracle [C7,H5,H16,A2]. */
import assert from 'node:assert/strict';
import {
  recordSelectorGap,
  relandAccepted,
} from '../../../../index.js';

/**
 * Submit one fresh item at `commit` with a narrow green gate selection, for a selector gap or a reland.
 * Why: both moves read the latest submit event, so each needs its own item with gateGreen and a criterion digest.
 */
function submitted({ board, box, store, submitFixture, agent, claim }, title, commit) {
  const item = store.addItem(board, { by: 'coordinator', lane: box.lane, title, criterion: 'A seeded lifecycle.' });
  store.claim(board, item, { ...claim, agentId: agent, lane: box.lane });
  submitFixture(board, item, { agentId: agent, commit, tree: 'b'.repeat(40), gateGreen: true,
    submissionProof: { version: 1, files: ['test/selected.test.js'], full: false, deferred: false, reason: 'synthetic narrow selection' } });
  return item;
}

/**
 * A reviewer's failing case outside the gate selection files one repair item without moving the builder's item.
 * The verdict receipt is a synthetic projection input; no review or gate execution is claimed.
 */
export async function seedSelectorGap(context) {
  const { board, store, exercise, reviewer } = context;
  const commit = 'd'.repeat(40), trunk = 'e'.repeat(40);
  const item = submitted(context, 'Selector gap parity', commit);
  const receiptId = 'parity-selector-gap-review';
  const failure = { file: 'test/unselected.test.js', name: 'unselected case' };
  store.logEvent(board, reviewer, 'proof-run', item, { receipt: { id: receiptId, kind: 'verdict', item, commit,
    tree: 'b'.repeat(40), frozenDigest: store.getItem(board, item).item_frozen_digest, seat: reviewer, sourceClean: true, exitCode: 1,
    counts: { passed: 0, failed: 1, skipped: 0 }, failures: [failure], testOutcomes: [{ ...failure, passed: false, skipped: false }] } });
  const review = { commit, head: commit, trunk, paths: [] };
  const recorded = await exercise('recordSelectorGap', () => recordSelectorGap(board, { agentId: reviewer, itemId: item, receiptId, review }));
  assert.equal(recorded?.filed, true, 'the native move files a real selector repair');
  assert.equal(store.getItem(board, item).item_status, 'submitted', 'the builder item stays submitted');
}

/** An accepted item a landing reopened returns to verified on its own accept and green gate. */
export async function seedAcceptedReland(context) {
  const { board, store, exercise, reviewer } = context;
  const commit = 'f'.repeat(40), merge = '1'.repeat(40);
  const item = submitted(context, 'Accepted reland parity', commit);
  store.reserveReview(board, item, { agentId: reviewer, lane: 'tests', leaseMs: 3600000, policy: 'any' });
  store.verify(board, item, { agentId: reviewer, decision: 'ACCEPT', head: commit, digest: store.getItem(board, item).item_frozen_digest,
    policy: 'any', note: 'Synthetic native state only; no gate execution claimed.' });
  store.reopen(board, item, { agentId: 'coordinator', note: `test/parity-batch.test.js: batch red; merge commit ${merge}` });
  assert.equal(store.getItem(board, item).item_status, 'open', 'the landing failure reopened the accepted item');
  const result = await exercise('relandAccepted', () => relandAccepted(board, item, { agentId: 'coordinator', main: '2'.repeat(40) }));
  assert.equal(result?.relanded, true, 'the native move returns the item on its own accept');
  assert.equal(store.getItem(board, item).item_status, 'verified');
}
