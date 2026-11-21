/** The board state document carries the stored clock health document, or null when no clock pass stored one [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import { writeBoardMeta } from '../../../../src/io/board/meta.js';
import { boardStateClock } from '../../../../src/io/board/state/clock.js';

test('store.io-board-state-clock.carries-clock: clause 1: [B4,C7] the clock the board state carries equals the document stored in board meta key clock.health', t => {
  const board = fixtureBoard(t);
  const doc = { version: 1, at: '2026-11-20T20:00:00.000Z', withoutOwnerDeadline: { count: 1, items: [7] }, overdue: 2, byRule: { 'open-unclaimed': 2 } };
  writeBoardMeta(board.db, 'clock.health', JSON.stringify(doc));
  assert.deepEqual(boardStateClock(board.db), doc);
});

test('store.io-board-state-clock.null-when-absent: clause 2: [B4,C7] with no stored clock document the state carries clock null', t => {
  const board = fixtureBoard(t);
  assert.equal(boardStateClock(board.db), null);
});
