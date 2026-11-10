/** Explicit statistics ports preserve native snapshot and fallback behavior [R1,R2,CD64,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFact } from '../../../../packages/store/index.js';
import { addItem } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { register } from '../../../../packages/store/index.js';
import { counterProofStats } from '../../../../packages/verify/index.js';
import { eventCounts } from '../../../../packages/stats/index.js';
import { proofStats } from '../../../../packages/stats/index.js';
import { proofStats as legacyProofStats } from '../fixtures/legacy.js';

/** Create a real private SQLite board populated through native writer operations. */
function fixture(t) {
  const board = openBoard(':memory:', { now: () => new Date('2026-01-01T00:00:00.000Z') });
  t.after(() => closeBoard(board));
  register(board, { lane: 'coordinator', path: '/fixture/coordinator' });
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'Port parity', criterion: 'native history remains intact' });
  const builder = register(board, { lane: 'web', path: '/fixture/builder' });
  appendFact(board, id, { agentId: builder, kind: 'note', text: 'Native port fixture note.' });
  return board;
}

test('statistics explicit native counter and fallback ports preserve complete results [R1,R2,CD64]', (t) => {
  const board = fixture(t);
  const options = { now: Date.parse('2026-01-02T00:00:00.000Z') };
  const expected = legacyProofStats(board, options);
  assert.deepEqual(expected.notesPerSubmit, [{ seat: 'web-1', notes: 1, submits: 0, notesPerSubmit: null }]);
  let historyReads = 0;
  let fallbacks = 0;
  const reads = {
    /** Count actual complete native history reads without changing their contents. */
    events(current) { historyReads += 1; return events(current); },
    counterProofStats,
  };
  assert.deepEqual(proofStats(board, options, reads), expected);
  assert.equal(historyReads, 0, 'current native counters avoid the legacy reader');
  const fallback = {
    ...reads,
    /** Model an unavailable counter through the explicit caller boundary. */
    counterProofStats() { return null; },
  };
  assert.deepEqual(proofStats(board, {
    ...options,
    /** Observe the actual legacy fallback notification. */
    onFallback() { fallbacks += 1; },
  }, fallback), expected);
  assert.equal(historyReads, 1);
  assert.equal(fallbacks, 1);
  assert.deepEqual(eventCounts(board, {}, reads), {
    since: expected.since, submissions: expected.submissions, rejections: expected.rejections,
    rejectionShare: expected.rejectionShare, merged: expected.merged,
    mergedWithoutAccept: expected.mergedWithoutAccept, firstEventAt: expected.firstEventAt,
    lastEventAt: expected.lastEventAt,
  });
  assert.equal(historyReads, 2);
});

test('statistics missing ports fail explicitly while malformed dates retain BAD_SINCE [R1,R2,C7]', (t) => {
  const board = fixture(t);
  assert.throws(() => proofStats(board), /explicit events and counterProofStats read ports/u);
  assert.throws(() => proofStats(board, {}, { events }), /explicit events and counterProofStats read ports/u);
  assert.throws(() => eventCounts(board), /explicit events read port/u);
  assert.throws(() => proofStats(board, { since: 'not-a-date' }), { code: 'BAD_SINCE' });
  assert.throws(() => eventCounts(board, { since: 'not-a-date' }), { code: 'BAD_SINCE' });
  const options = { now: Date.parse('2026-01-02T00:00:00.000Z') };
  assert.deepEqual(proofStats(board, options, { events, counterProofStats }), legacyProofStats(board, options));
});
