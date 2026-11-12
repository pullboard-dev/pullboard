/** @pullboard-test-input packages/landing/index.js */
/** Landing applies the main-owned rule (#3534): a submit recorded green with its only reds owned by main is reused at landing [C7,#3685]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingReceiptReuse } from '../../../../../packages/landing/index.js';

const MAIN_RED = 'web/main-red.test.js';
const MAIN_RED_CASE = 'main red case [G1]';

test('clause 1: control: known main failures not covered by a green main-owned verdict are never reused [C7,#3685]', () => {
  const treeOf = rev => ({ main1: 'treeBase', policy: 'treeBase' })[rev] ?? null;
  const known = { main: 'main1', failures: [{ file: MAIN_RED, name: MAIN_RED_CASE, item: 2 }] };
  const submit = { commit: 'c1', tree: 'treeC', tooling: 'treeT', policyCommit: 'policy', gateGreen: true,
    submissionProof: { version: 1, files: ['test/a.test.js'], full: false, deferred: false, knownMainFailures: known } };
  const input = verdict => ({ items: [{ id: 7, commit: 'c1' }], readEvents: () => [{ event_kind: 'submit', event_detail: JSON.stringify(submit) }],
    tree: 'treeC', base: 'main1', tooling: 'treeT', full: false, files: ['test/a.test.js', MAIN_RED], treeOf, verdictOf: () => verdict });
  const green = { green: true, mainOwned: [{ file: MAIN_RED, name: MAIN_RED_CASE, receipt: 'r1' }] };
  assert.equal(landingReceiptReuse(input(green)).reuse, true, 'a green verdict owning every listed case is reused, its file counted as proved');
  assert.equal(landingReceiptReuse(input(null)).code, 'NOT_GREEN', 'no verdict: the receipt is red');
  assert.equal(landingReceiptReuse(input({ ...green, green: false })).code, 'NOT_GREEN', 'a red verdict is never reused');
  assert.equal(landingReceiptReuse(input({ green: true, mainOwned: [{ file: MAIN_RED, name: 'another case' }] })).code, 'NOT_GREEN', 'a case the verdict does not own stays red');
  const changed = { ...input(green), tree: 'treeD', generated: ['docs/badges/items.json'] };
  assert.equal(landingReceiptReuse({ ...changed, changedPaths: () => ['docs/badges/items.json'] }).reuse, true, 'a tree changed only by the landing\'s own badge write is the proved tree');
  assert.equal(landingReceiptReuse({ ...changed, changedPaths: () => ['docs/badges/items.json', 'src/a.js'] }).code, 'CANDIDATE_CHANGED', 'any other change runs the gate');
});
