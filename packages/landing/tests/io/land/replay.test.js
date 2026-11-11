/** Landing replay decides recorded batches from the board alone, in seconds [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { fixtureBoard } from '../../../../../apps/cli/tests/fixtures/board.js';
import { replayBatch } from '../../../index.js';
import { replayLanding } from '../../../index.js';

const sha = char => char.repeat(40);
const gate = (isGreen, failures = []) => ({ commit: sha('a'), isGreen, submissions: [{ id: 7, commit: sha('b') }], failures, fileTimes: [] });
const batch = (id, gates, extra = {}) => ({ version: 1, id, state: 'blocked', items: [{ id: 7, commit: sha('b') }, { id: 8, commit: sha('c') }],
  updatedAt: '2026-11-05T10:00:00.000Z', invariantEvidence: { version: 1, gates, diagnostics: [] }, ...extra });

test('clause 1: land --replay decides land, bisect, known-main and hold from recorded gates [C7]', () => {
  assert.equal(replayBatch(batch('g', [gate(true)])).decision, 'land');
  const red = replayBatch(batch('r', [gate(false, ['test/a.test.js'])]));
  assert.equal(red.decision, 'bisect to culprits');
  assert.deepEqual(red.files, ['test/a.test.js']);
  assert.equal(red.comparison, 'would be needed', 'no comparison is recorded, so replay says so');
  assert.equal(replayBatch(batch('k', [gate(false, ['test/a.test.js'])], { knownMain: ['test/a.test.js'] })).decision, 'set aside known-main');
  const held = replayBatch(batch('h', [gate(false)]));
  assert.equal(held.decision, 'hold');
  assert.match(held.stop, /names no failing file/u);
  assert.equal(replayBatch(batch('n', [])).decision, 'hold');
});

test('clause 2: land --replay reads 50 batches in under 5 s, starts nothing and leaves the board unchanged [C7]', { timeout: 5000 }, t => {
  const board = fixtureBoard(t);
  for (let index = 0; index < 50; index++) {
    store.logEvent(board, 'coordinator', 'landing_batch', null, { batch: batch(`b${index}`, [gate(index % 2 === 0, index % 2 ? ['test/a.test.js'] : [])],
      { updatedAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString() }) });
  }
  const before = board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  const rows = replayLanding(board);
  assert.equal(rows.length, 50);
  assert.equal(rows.filter(row => row.decision === 'land').length, 25);
  assert.equal(rows.filter(row => row.decision === 'bisect to culprits').length, 25);
  assert.equal(replayLanding(board, { since: '2026-11-03T00:00:00Z' }).length, 0);
  assert.equal(replayLanding(board, { since: '2026-11-01T00:24:00Z' }).length, 26);
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, before);
});
