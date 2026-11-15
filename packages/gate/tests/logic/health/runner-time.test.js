/** @pullboard-test-input source-cell gate */
/** Runner minutes are summed by purpose, and the share no item and purpose can be charged for is reported [C7,#8184]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runnerTimeLines } from '../../../index.js';
import { runnerTimeSummary } from '../../../index.js';

/** One sidecar line. */
const dispatch = (item, kind, minutes) => ({ v: 1, host: 'runner-a', item, kind, minutes, start: '2026-11-15T12:00:00.000Z', end: '2026-11-15T12:01:00.000Z', outcome: 'ok' });

test('clause 1: runner minutes are reported by purpose, the largest first [C7]', () => {
  const summary = runnerTimeSummary([dispatch('4000', 'gate', 2), dispatch('4001', 'gate', 3), dispatch('4002', 'landing', 10), dispatch('4003', 'doctrine', 1)]);
  assert.deepEqual(summary.byPurpose, [{ purpose: 'landing', dispatches: 1, minutes: 10 }, { purpose: 'gate', dispatches: 2, minutes: 5 }, { purpose: 'doctrine', dispatches: 1, minutes: 1 }]);
  assert.equal(summary.minutes, 16);
  const lines = runnerTimeLines(summary).join('\n');
  assert.match(lines, /^runner time by purpose \(4 dispatches, 16\.0 minutes\):/u);
  assert.match(lines, /landing\s+1 dispatches\s+10\.0 min/u);
  assert.match(lines, /gate\s+2 dispatches\s+5\.0 min/u);
});

test('clause 2: a dispatch naming no item or no kind is unattributed, and its share of all minutes is reported [C7]', () => {
  const summary = runnerTimeSummary([dispatch('4000', 'gate', 6), dispatch('', 'gate', 1), dispatch('4001', '', 2), dispatch('', '', 1)]);
  assert.deepEqual(summary.unattributed, { dispatches: 3, minutes: 4 });
  assert.equal(summary.unattributedShare, 0.4);
  assert.deepEqual(summary.byPurpose, [{ purpose: 'gate', dispatches: 1, minutes: 6 }]);
  assert.match(runnerTimeLines(summary).join('\n'), /unattributed share of runner minutes: 40\.0%/u);
});

test('clause 2: a window with no dispatch reports none and no share [C7]', () => {
  const summary = runnerTimeSummary([]);
  assert.equal(summary.unattributedShare, null);
  assert.deepEqual(runnerTimeLines(summary), ['runner time: no runner dispatch recorded in this window']);
});
