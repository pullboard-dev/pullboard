/** @pullboard-test-input source-cell packages/store */
/** editItem with a specs argument replaces an item's cited spec rows and refreezes its bar with the new rows' text in one edit move [C7,#12103]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { editItem } from '../../../src/io/board/edit.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';

const ROWS = { G1: 'The first row text.', G2: 'The second row text.', G3: 'The third row text.' };
/** The freezer the CLI sends with a correction, reduced to the pieces this test reads: the criterion, its check and the cited rows' text. */
const freeze = item => {
  const rows = item.item_spec_ids.split(',').filter(Boolean).map(id => ({ id, text: ROWS[id] }));
  const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows });
  return { text, digest: createHash('sha256').update(text).digest('hex') };
};
const events = board => board.db.prepare("SELECT event_by, event_kind, event_detail FROM event WHERE event_kind = 'edit' ORDER BY event_id").all();
const open = (board, specIds) => cellItem(board, { lane: 'core', title: 'cited rows', criterion: '1. It works [test].', specIds, route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' });

test('store.io-board-edit-specs.replaces-rows-and-refreezes: clause 1: editItem with specs and a reason replaces the open item\'s cited rows, refreezes its bar with the new rows\' text and records one edit move; without specs the rows are untouched [C7,#12103]', t => {
  const board = cellBoard(t, ':memory:', { now: () => new Date() });
  const { item_id: id } = open(board, ['G1']);
  const before = events(board).length;
  editItem(board, id, { agentId: 'coordinator', specs: ['G2', 'G3'], reason: 'the first row was the wrong one', correction: true, freeze });
  const row = board.db.prepare('SELECT item_spec_ids, item_frozen, item_frozen_digest FROM item WHERE item_id = ?').get(id);
  assert.equal(row.item_spec_ids, 'G2,G3');
  assert.deepEqual(JSON.parse(row.item_frozen).rows, [{ id: 'G2', text: ROWS.G2 }, { id: 'G3', text: ROWS.G3 }]);
  assert.equal(row.item_frozen_digest, createHash('sha256').update(row.item_frozen).digest('hex'));
  const written = events(board).slice(before);
  assert.equal(written.length, 1, 'one edit move');
  assert.deepEqual(JSON.parse(written[0].event_detail), { reason: 'the first row was the wrong one', specIds: ['G2', 'G3'], previousSpecIds: ['G1'] });
  editItem(board, id, { agentId: 'coordinator', brief: 'Files: src/b.js\nTest: proves it' });
  assert.equal(board.db.prepare('SELECT item_spec_ids FROM item WHERE item_id = ?').get(id).item_spec_ids, 'G2,G3', 'an edit without specs keeps the cited rows');
  assert.equal('specIds' in JSON.parse(events(board).at(-1).event_detail), false, 'and records no spec change');
});

test('store.io-board-edit-specs.refuses-bad-lists: clause 1: editItem refuses an empty, repeated or reasonless specs list and changes nothing [C7,#12103]', t => {
  const board = cellBoard(t, ':memory:', { now: () => new Date() });
  const { item_id: id } = open(board, ['G1']);
  const before = events(board).length;
  assert.throws(() => editItem(board, id, { agentId: 'coordinator', specs: [], reason: 'x' }), { code: 'BAD_SPECS' });
  assert.throws(() => editItem(board, id, { agentId: 'coordinator', specs: ['G2', 'G2'], reason: 'x' }), { code: 'BAD_SPECS' });
  assert.throws(() => editItem(board, id, { agentId: 'coordinator', specs: ['G2'] }), { code: 'BAR_REASON' });
  assert.equal(board.db.prepare('SELECT item_spec_ids FROM item WHERE item_id = ?').get(id).item_spec_ids, 'G1');
  assert.equal(events(board).length, before, 'a refused edit records no move');
});
