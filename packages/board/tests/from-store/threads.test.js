/** One pass over the event list gives every item its thread, as the per-item read does, so a cold state build never reads the log once per item [C7,#8480]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { itemThreads } from '../../../store/index.js';
import { cellBoard } from '../fixtures/cell-board.js';

// fixture-subject: addItem (a store unit test of itemThreads over seeded events; the board is opened through the kit)

/** A board of three items with facts, a usage row (never in a thread) and board-wide main moves that name items in every shape the log holds. */
function fixture(t) {
  let at = Date.parse('2026-11-15T00:00:00.000Z');
  const board = cellBoard(t, ':memory:', { now: () => new Date(at += 1000) }, { real: false });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const ids = ['one', 'two', 'three'].map(title => store.addItem(board, { by: 'coordinator', lane: 'web', title, criterion: `${title} works` }));
  const insert = board.db.prepare('INSERT INTO event (item_id, event_kind, event_by, event_at, event_detail) VALUES (?, ?, ?, ?, ?)');
  const stamp = () => new Date(at += 1000).toISOString();
  insert.run(ids[0], 'usage', 'coordinator', stamp(), '{}');
  insert.run(null, 'main-moved', 'board', stamp(), JSON.stringify({ sha: 'a', items: [ids[0], ids[2], ids[0]] }));
  insert.run(null, 'main-moved', 'board', stamp(), 'not json');
  insert.run(null, 'main-moved', 'board', stamp(), JSON.stringify({ sha: 'b', items: [String(ids[1]), 1.5, null] }));
  insert.run(null, 'main-moved', 'board', stamp(), JSON.stringify({ sha: 'c', items: ids[1] }));
  insert.run(ids[1], 'fact', 'coordinator', stamp(), JSON.stringify({ kind: 'note', text: 'a fact' }));
  return { board, ids };
}

test('clause 1: itemThreads gives each item the thread itemThread reads, main moves in event order and usage left out [C7,#8480]', t => {
  const { board, ids } = fixture(t);
  const threads = itemThreads(board, ids, store.events(board));
  for (const id of ids) assert.deepEqual(threads.get(id), store.itemThread(board, id), `item ${id}`);
  assert.deepEqual(threads.get(ids[0]).filter(entry => entry.kind === 'main-moved').length, 1, 'a main move naming an item twice lists once');
  assert.equal(threads.get(ids[1]).some(entry => entry.kind === 'main-moved'), true, 'a main move whose items is one integer names it');
  assert.equal(threads.get(ids[0]).some(entry => entry.kind === 'usage'), false);
});
