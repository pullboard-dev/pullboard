/** A landing reruns its items' submit proof, never the full plan, and a runners-only machine lands one item a batch [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingMaximum } from '../packages/landing/index.js';
import { landingProgress, LANDING_GATE_CEILING_MS } from '../packages/landing/src/shell/landing-in-process.js';
import { submitProved, submittedSelections } from '../packages/landing/src/shell/landing-step-gate.js';

/** #3489's submit on 9 Nov: red only in the relay cases main fails the same way, recorded with gateGreen false. */
function knownMainSubmit(commit) {
  return { commit, gateGreen: false, submissionProof: { version: 1, files: ['test/relay-snapshot-size.test.js', 'test/relay.test.js'], full: false, deferred: true,
    knownMainFailures: { main: 'a'.repeat(40), failures: [{ file: 'test/relay.test.js', name: 'pairing-cancel', signature: 'b'.repeat(64), item: 3461 }] } } };
}

/** A submit event row as the board stores it. */
function submitRow(detail) {
  return { event_kind: 'submit', event_detail: JSON.stringify(detail) };
}

test('clause 1: a submit admitted on main-owned reds is a proof, so its files plan the landing instead of the full plan [C7]', () => {
  const commit = 'c'.repeat(40);
  assert.equal(submitProved(knownMainSubmit(commit)), true);
  assert.equal(submitProved({ commit, gateGreen: true }), true);
  assert.equal(submitProved({ ...knownMainSubmit(commit), submissionProof: { files: ['test/relay.test.js'] } }), false, 'red with no main-owned account proves nothing');
  assert.equal(submitProved({ commit }), false);
  const entries = [{ id: 3489, commit }];
  const files = submittedSelections(entries, () => [submitRow(knownMainSubmit(commit))], () => []);
  assert.deepEqual(files, ['test/relay-snapshot-size.test.js', 'test/relay.test.js'], 'the plan is the submit proof, not null (which fell back to the full plan)');
  assert.equal(submittedSelections(entries, () => [submitRow({ ...knownMainSubmit(commit), gateGreen: undefined })], () => []), null);
  assert.equal(submittedSelections([{ id: 3489, commit: 'd'.repeat(40) }], () => [submitRow(knownMainSubmit(commit))], () => []), null, 'another commit\'s submit is not this proof');
});

test('clause 3: on a runners-only machine every landing batch takes one item, so each lands on its own submit proof [C7]', () => {
  const batched = { landing: { perItem: false } };
  // One item a batch is decided before any board read.
  assert.equal(landingMaximum(null, batched, Infinity, true, { runnersOnly: true }), 1);
  assert.equal(landingMaximum(null, batched, Infinity, false, { runnersOnly: true }), 1, 'a hand landing too');
  assert.equal(landingMaximum(null, { landing: { perItem: true } }, Infinity, true, { runnersOnly: false }), 1, 'per-item landing keeps one');
});

test('clause 4: a gate still running on a runner is progress, so the 10-minute stop never ends it; past its ceiling it is not [C7]', () => {
  let clock = 0;
  const progress = landingProgress({ now: () => clock });
  progress.said('gate candidate: 1392 files selected; running');
  clock = 30 * 60_000;
  assert.equal(progress.lastProgressAt(), clock, 'thirty silent minutes of a running gate still count as progress');
  progress.said('gate candidate: run finished green');
  clock += 11 * 60_000;
  assert.equal(progress.lastProgressAt(), 30 * 60_000, 'after the run ends, silence is no progress again');
  progress.said('gate candidate: 2 files selected; running');
  const opened = clock;
  clock += LANDING_GATE_CEILING_MS + 1;
  assert.equal(progress.lastProgressAt(), opened, 'a gate past its ceiling no longer counts');
});
