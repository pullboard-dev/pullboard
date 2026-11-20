/** The allowance warning is one line by percent left, and an unknown allowance names itself [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowanceWarning } from '../../src/logic/allowance.js';

const reading = percentLeft => ({ known: true, percentLeft, windowMinutes: 300, resetsAt: '2026-11-18T20:00:00.000Z' });

test('stats.allowance-warning.above-twenty-percent-is-no-warning: clause 1: above 20 percent left there is no warning line [C7]', () => {
  assert.equal(allowanceWarning(reading(20.5), 'coordinator'), null);
  assert.equal(allowanceWarning(reading(100), 'coordinator'), null);
});

test('stats.allowance-warning.fifteen-percent-gets-the-warning: clause 2: from 20 down to above 5 percent left one warning line names the seat, the percent left and the reset time [C7]', () => {
  assert.equal(allowanceWarning(reading(15), 'coordinator'), 'warning: coordinator allowance 15% left, resets 2026-11-18T20:00:00.000Z');
  assert.match(allowanceWarning(reading(20), 'core-1'), /^warning: core-1 allowance 20% left/u);
  assert.match(allowanceWarning(reading(5.01), 'core-1'), /^warning: /u);
});

test('stats.allowance-warning.five-percent-is-urgent-and-unknown-says-so: clause 3: at 5 percent left or less one urgent line, and an unknown allowance returns "<seat> allowance: unknown" [C7]', () => {
  assert.equal(allowanceWarning(reading(5), 'coordinator'), 'urgent: coordinator allowance 5% left, resets 2026-11-18T20:00:00.000Z');
  assert.match(allowanceWarning(reading(0), 'core-1'), /^urgent: core-1 allowance 0% left/u);
  assert.equal(allowanceWarning({ known: false }, 'core-2'), 'core-2 allowance: unknown');
});
