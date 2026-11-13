/** @pullboard-test-input packages/landing/index.js */
/** A one-item landing reuses its green submit proof when main moved since the submit, rerunning only the tests whose import closure main's commits reach [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingReceiptReuse } from '../../../../../packages/landing/index.js';

const ITEM_TEST = 'web/item.test.js';

/** The pure verdict's input: one submit of c1 on main1 with a deferred proof, landing on main2 with closure `reach`. */
function closureInput({ moved = ['web/main.txt'], drift = moved, reach = {}, deferredFiles = [], candidates = [ITEM_TEST, 'web/other.test.js'] } = {}) {
  const trees = { main1: 'treeBase', main2: 'treeMoved' };
  const diffs = { 'treeBase>treeMoved': moved, 'treeC>treeM': drift, 'treeT>treeM': drift };
  const submit = { commit: 'c1', tree: 'treeC', policyCommit: 'main1', tooling: 'treeT', gateGreen: true,
    submissionProof: { version: 1, files: [ITEM_TEST], full: false, deferred: true, deferredFiles } };
  return { items: [{ id: 7, commit: 'c1' }], readEvents: () => [{ event_kind: 'submit', event_detail: JSON.stringify(submit) }],
    tree: 'treeM', base: 'main2', tooling: 'treeM', full: false, files: candidates, treeOf: rev => trees[rev] ?? null,
    changedPaths: (from, to) => diffs[`${from}>${to}`] ?? null,
    closure: { candidates: () => candidates, closureChanged: (file, changed) => (reach[file] ?? [file]).some(path => changed.has(path)) } };
}

test('clause 1: a deferred proof on a moved main is reused, rerunning only the files whose import closure main\'s commits reach [C7]', () => {
  assert.deepEqual(landingReceiptReuse(closureInput()).rerun, [], 'no closure reaches main\'s change: nothing reruns');
  const reached = landingReceiptReuse(closureInput({ reach: { [ITEM_TEST]: [ITEM_TEST, 'web/main.txt'] } }));
  assert.equal(reached.reuse, true);
  assert.deepEqual(reached.rerun, [ITEM_TEST], 'only the file whose closure main changed reruns');
  assert.deepEqual(landingReceiptReuse(closureInput({ deferredFiles: ['web/other.test.js'] })).rerun, ['web/other.test.js'], 'a file the submit deferred still runs');
});

test('clause 1: control: a merged tree that differs from the submit tree beyond main\'s commits runs the gate [C7]', () => {
  assert.equal(landingReceiptReuse(closureInput({ drift: ['web/main.txt', 'web/elsewhere.js'] })).code, 'CANDIDATE_CHANGED');
  assert.equal(landingReceiptReuse(closureInput({ moved: null, drift: [] })).code, 'BASE_MOVED', 'main\'s change set cannot be read');
  assert.equal(landingReceiptReuse({ ...closureInput(), closure: null }).code, 'NOT_GREEN', 'an untiered landing keeps exact-tree reuse');
});
