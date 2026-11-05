/** Tier 1 is recorded beside the independent verdict without changing that verdict [V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tier1ShadowFact } from '../apps/cli/src/shell/tier1-shadow-verdict.js';

test('a passing Tier 1 shadow can differ from the real rejection without changing it [V4]', () => {
  const realVerdict = 'REJECT';
  const fact = tier1ShadowFact([{ event_kind: 'submit', event_detail: JSON.stringify({
    gateGreen: true, commit: 'a'.repeat(40), submissionProof: { files: ['test/unit.test.js'], deferred: true },
  }) }], { state: 'pass' }, realVerdict, 'a'.repeat(40));

  assert.match(fact, /Tier-1 shadow verdict at a{12}: ACCEPT; real reviewer verdict: REJECT/u);
  assert.equal(realVerdict, 'REJECT');
});

test('no Tier 1 fact is emitted without exact green submission and review evidence [V4]', () => {
  const head = 'b'.repeat(40);
  const events = [{ event_kind: 'submit', event_detail: JSON.stringify({ gateGreen: false, commit: head,
    submissionProof: { files: ['test/unit.test.js'], deferred: true } }) }];

  assert.equal(tier1ShadowFact(events, { state: 'pass' }, 'ACCEPT', head), null);
  assert.equal(tier1ShadowFact(events, { state: 'unverified' }, 'REJECT', head), null);
  assert.equal(tier1ShadowFact(events, { state: 'pass' }, 'ACCEPT', 'c'.repeat(40)), null);
});
