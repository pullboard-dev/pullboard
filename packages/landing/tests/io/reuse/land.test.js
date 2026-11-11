import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingReceiptReuse } from '../../../index.js';
import { reusableSubmitProof } from '../../../../verify/index.js';

const trees = { main1: 'treeBase', main2: 'treeMoved', c1: 'treeC' };
const treeOf = rev => trees[rev] ?? null;
const submit = (extra = {}, proof = {}) => [{ event_id: 1, event_kind: 'submit', event_detail: JSON.stringify({
  commit: 'c1', tree: 'treeC', policyCommit: 'main1', tooling: 'treeTools', gateGreen: true, submissionProof: { full: false, deferred: false, files: ['test/a.test.js'], ...proof }, ...extra }) }];
const input = (over = {}) => ({ items: [{ id: 7, commit: 'c1' }], readEvents: () => submit(), tree: 'treeC', base: 'main1', tooling: 'treeTools', full: false, files: ['test/a.test.js'], treeOf, ...over });

test('clause 1: landing reuses the submit receipt when candidate, base and tooling trees match and starts no test run [C7]', () => {
  const verdict = landingReceiptReuse(input());
  assert.deepEqual(verdict, { reuse: true, code: null, item: 7, commit: 'c1', tree: 'treeC' });
});

test('clause 1: landing runs the gate when the candidate tree, the base tree, the tooling tree or the plan changed [C7]', () => {
  assert.equal(landingReceiptReuse(input({ tree: 'treeX' })).code, 'CANDIDATE_CHANGED');
  assert.equal(landingReceiptReuse(input({ base: 'main2' })).code, 'BASE_MOVED');
  assert.equal(landingReceiptReuse(input({ tooling: 'treeOtherTools' })).code, 'TOOLING_CHANGED');
  assert.equal(landingReceiptReuse(input({ tooling: null })).code, 'TOOLING_CHANGED');
  assert.equal(landingReceiptReuse(input({ readEvents: () => submit({ tooling: undefined }) })).code, 'TOOLING_CHANGED');
  assert.equal(landingReceiptReuse(input({ files: ['test/a.test.js', 'test/b.test.js'] })).code, 'PLAN_WIDER');
  assert.equal(landingReceiptReuse(input({ full: true })).code, 'PLAN_WIDER');
  assert.equal(landingReceiptReuse(input({ readEvents: () => submit({ gateGreen: false }) })).code, 'NO_RECEIPT');
  assert.equal(landingReceiptReuse(input({ readEvents: () => submit({}, { knownMainFailures: [1] }) })).code, 'NOT_GREEN');
  assert.equal(landingReceiptReuse(input({ items: [{ id: 7, commit: 'c1' }, { id: 8, commit: 'c2' }] })).code, 'BATCH_OF_MANY');
});

test('clause 1: review reuses the submit proof only when commit, tree, base and tooling tree are unchanged, else names what changed [C7]', () => {
  const item = { item_id: 7, item_frozen_digest: 'd' };
  const events = submit({ criterionDigest: 'd' });
  const base = { item, commit: 'c1', tree: 'treeC', main: 'main1', tooling: 'treeTools', check: '', affectedTests: 'node --test', gate: 'true', expectedPlan: null };
  assert.equal(reusableSubmitProof(events, { ...base, tree: 'treeX' }).reason, 'commit or tree changed');
  assert.equal(reusableSubmitProof(events, { ...base, main: 'main2' }).reason, 'composed main changed');
  assert.equal(reusableSubmitProof(events, { ...base, tooling: 'treeOtherTools' }).reason, 'tooling tree changed');
  assert.equal(reusableSubmitProof(events, { ...base, tooling: null }).reason, 'tooling tree changed');
  assert.equal(reusableSubmitProof(submit({ criterionDigest: 'd', tooling: undefined }), base).reason, 'tooling tree changed');
  // Same candidate, base and tooling: the key matches, so the next refusal is about the recorded admission, not a tree.
  assert.equal(reusableSubmitProof(events, base).reason, 'no linked submit admission');
});
