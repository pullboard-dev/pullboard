/** @pullboard-test-input source-cell packages/store */
/** appendMark writes one mark event for an open item and nothing else, and refuses an item that does not exist [C7,#12157]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendMark } from '../../../src/io/board/mark.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';

const events = board => board.db.prepare('SELECT event_by, event_kind, item_id, event_detail FROM event ORDER BY event_id').all();

test('store.mark.one-event: clause 1: appendMark appends exactly one mark event whose detail is stage, edge, reason, ref and at, and an unknown item is refused with no event [C7,#12157]', t => {
  const board = cellBoard(t, ':memory:', { now: () => new Date() });
  const id = cellItem(board, { lane: 'core', title: 'marked item', criterion: 'one', route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' }).item_id;
  const before = events(board);
  const mark = { agentId: 'core-1', stage: 'seat-ready', edge: 'point', reason: null, ref: 'abc', at: 1_700_000_000_000 };
  appendMark(board, id, mark);
  const after = events(board);
  assert.equal(after.length, before.length + 1, 'exactly one event is appended');
  const written = after.at(-1);
  assert.equal(written.event_kind, 'mark');
  assert.equal(written.item_id, id);
  assert.equal(written.event_by, 'core-1');
  assert.deepEqual(JSON.parse(written.event_detail), { stage: 'seat-ready', edge: 'point', reason: null, ref: 'abc', at: 1_700_000_000_000 });
  assert.throws(() => appendMark(board, id + 999, mark), error => error.code === 'NO_ITEM');
  assert.equal(events(board).length, after.length, 'a refused mark writes no event');
});
