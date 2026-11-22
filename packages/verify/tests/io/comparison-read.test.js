/** Comparison rendering distinguishes selected executions from project test coverage [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO_SELECTED_COMPARISON_EXECUTION } from '../../src/io/comparison-read.js';
import { renderVerificationComparison } from '../../src/io/comparison-read.js';

test('verify.io-comparison-read.empty-selection: clause 1: empty sources name missing comparison execution without claiming no tests or a clean comparison [V4,C7]', () => {
  const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
  const rendered = renderVerificationComparison({ item: 12898, headCommit: headSha, baseCommit: baseSha,
    head: { id: null }, base: { id: 'run-base' }, newRed: null, fixed: null });
  assert.match(rendered, new RegExp(`head ${headSha}: ${NO_SELECTED_COMPARISON_EXECUTION}`, 'u'));
  assert.match(rendered, new RegExp(`base ${baseSha}: run run-base`, 'u'));
  assert.match(rendered, /Case comparison incomplete/u);
  assert.doesNotMatch(rendered, /no tests at|No new red or fixed cases|gate tests did not run/iu);
});

test('verify.io-comparison-read.observed-results: clause 2: pending and unavailable reasons, run identities and observed changed cases remain visible [V4,C7]', () => {
  assert.equal(renderVerificationComparison({ status: 'pending', item: 12898 }), 'comparison pending for #12898');
  assert.equal(renderVerificationComparison({ status: 'unavailable', error: 'worker offline' }),
    "comparison unavailable: worker offline; review on the item's gate receipts");
  const headSha = 'c'.repeat(40), baseSha = 'd'.repeat(40);
  const rendered = renderVerificationComparison({ item: 12898, headCommit: headSha, baseCommit: baseSha,
    head: { id: 'run-head' }, base: { id: 'run-base' },
    newRed: [{ file: 'new.test.js', name: 'clause 1: new failure' }],
    fixed: [{ file: 'old.test.js', name: 'clause 2: fixed failure' }] });
  assert.match(rendered, new RegExp(`head ${headSha}: run run-head`, 'u'));
  assert.match(rendered, new RegExp(`base ${baseSha}: run run-base`, 'u'));
  assert.match(rendered, /new red: new\.test\.js: clause 1: new failure/u);
  assert.match(rendered, /fixed: old\.test\.js: clause 2: fixed failure/u);
});
