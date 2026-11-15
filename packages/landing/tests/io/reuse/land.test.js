import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reusableSubmitProof } from '../../../../verify/index.js';

const trees = { main1: 'treeBase', main2: 'treeMoved', c1: 'treeC' };
const treeOf = rev => trees[rev] ?? null;
const submit = (extra = {}, proof = {}) => [{ event_id: 1, event_kind: 'submit', event_detail: JSON.stringify({
  commit: 'c1', tree: 'treeC', policyCommit: 'main1', tooling: 'treeTools', gateGreen: true, submissionProof: { full: false, deferred: false, files: ['test/a.test.js'], ...proof }, ...extra }) }];

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
