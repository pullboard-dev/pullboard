/** Verify accept reuses the gate's recorded receipt for a frozen check that is plain node --test (#8557) [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { reusableSubmitProof } from '../../src/io/reuse.js';
import { submitReusePlanDigest } from '../../src/logic/plan.js';

const CHECK = 'node --test apps/cli/journeys/cells/seals.test.js';
const digest = command => createHash('sha256').update(command).digest('hex');

test('clause 2: verify accept uses the recorded submit receipt for a plain node --test check without rerunning it [C7]', () => {
  const commit = 'c'.repeat(40), tree = 't'.repeat(40), main = 'm'.repeat(40), tooling = 'o'.repeat(40);
  const item = { item_id: 6435, item_frozen_digest: 'frozen' };
  const planDigest = submitReusePlanDigest({ check: CHECK, files: [], full: false, deferred: false, proofCommand: '' });
  const events = [
    { event_id: 1, event_by: 'seat', event_kind: 'claim', event_detail: JSON.stringify({ submitAdmission: { id: 'adm', commit, tree } }) },
    { event_id: 2, event_by: 'seat', event_kind: 'proof-run', event_detail: JSON.stringify({ receipt: { id: 'run-1', kind: 'submit', submitReuse: true, submitAdmission: 'adm',
      submitPhase: 'criterion', command: digest(CHECK), item: 6435, seat: 'seat', commit, tree, main, frozenDigest: 'frozen', submitReusePlan: planDigest,
      sourceClean: true, green: true, exitCode: 0 } }) },
    { event_id: 3, event_by: 'seat', event_kind: 'submit', event_detail: JSON.stringify({ commit, tree, policyCommit: main, tooling, criterionDigest: 'frozen', gateGreen: true,
      submissionProof: { files: [], full: false, deferred: false } }) },
  ];
  const reused = reusableSubmitProof(events, { item, commit, tree, main, tooling, check: CHECK, affectedTests: '', gate: '' });
  assert.deepEqual(reused.ids, ['run-1'], `the gate's receipt covers the frozen check, got ${JSON.stringify(reused)}`);
  const other = reusableSubmitProof(events, { item, commit, tree, main, tooling, check: `${CHECK} --other`, affectedTests: '', gate: '' });
  assert.match(other.reason, /receipt missing/u, 'a different check is never covered by that receipt');
});
