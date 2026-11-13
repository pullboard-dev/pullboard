/** A pulled gate receipt keeps a phase's per-case outcomes whole or drops them, never partly [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitReceipt } from '../../src/logic/runner/output.js';

test('a receipt over its cap drops a phase\'s per-case outcomes whole and keeps them whole when it fits [V4,C7]', () => {
  const outcomes = Array.from({ length: 800 }, (_, index) => ({ file: 'a.test.js', name: `case ${index} `.padEnd(80, 'x'), passed: true, skipped: false }));
  const fits = fitReceipt({ phases: [{ role: 'proof', status: 0, tail: '', testOutcomes: outcomes }] }, 256 * 1024);
  assert.equal(fits.phases[0].testOutcomes.length, 800, 'a receipt under its cap keeps every outcome');
  const over = fitReceipt({ phases: [{ role: 'proof', status: 0, tail: 'x'.repeat(2000), testOutcomes: outcomes }] }, 4 * 1024);
  assert.equal(over.phases[0].testOutcomes, undefined, 'a receipt over its cap carries no partial outcome list');
});
