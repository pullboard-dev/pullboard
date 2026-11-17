/** A submit's long selection reason fits its proof and says what it cut [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedProofReason } from '../../../src/logic/submission/proof.js';
import { submissionProof } from '../../../src/logic/submission/proof.js';

test('state.logic-engines-reuse-engine.a-selection-reason-longer-than-a-proof: a selection reason longer than a proof holds is cut and names what it elided [C7]', () => {
  const reason = 'selected because '.concat('test/cockpit/example.test.js reads src/view/page-render.js; '.repeat(800));
  assert.ok(reason.length > 40_000, 'the case reproduces the 47,949-character reason that refused #1605');
  const bounded = boundedProofReason(reason);
  assert.ok(bounded.length <= 8192, `bounded to the proof limit: ${bounded.length}`);
  assert.match(bounded, new RegExp(`\\+${reason.length - 8000} characters elided`), 'the cut is declared with its size');
  const proof = submissionProof({ version: 1, files: ['test/cockpit/example.test.js'], full: false, deferred: false, reason: bounded });
  assert.equal(proof.reason, bounded, 'the bounded reason passes the proof validator');
  assert.throws(() => submissionProof({ version: 1, files: [], full: false, deferred: false, reason }), /SUBMISSION_PROOF|submission proof/u,
    'the raw reason is still refused, so the producer must bound it');
});

test('state.logic-engines-reuse-engine.a-reason-that-already-fits-is-kept-word: a reason that already fits is kept word for word [C7]', () => {
  const reason = 'selected by the changed files';
  assert.equal(boundedProofReason(reason), reason);
});
