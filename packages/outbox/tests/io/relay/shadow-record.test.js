/** With moves.shadow on, the relay outbox writer records each outbox table shadow compare on the board; off, it runs no table [C7,#8389]. */
/** @pullboard-test-input packages/outbox/src/io/relay/shadow.js packages/store/src/io/board/shadow-record.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { readShadow } from '../../../../store/index.js';
import { provideOutboxTable } from '../../../index.js';
import { shadowOutbox } from '../../../index.js';

const AT = Date.parse('2026-11-15T12:00:00.000Z');
const doc = (...parked) => ({ baseSequence: 4, moves: parked.map(is => ({ parked: is ? { code: 'X' } : undefined })) });
// The moves cell sits above the outbox cell, so this stands in for the outbox table's queue and park rows: a queue adds a move and an empty outbox is queued, a park adds a parked one.
const table = (snapshot, move) => {
  const { outbox } = snapshot;
  if (move.name === 'queue') return { patch: { outbox: { ...outbox, moves: outbox.moves + 1, state: outbox.state === 'none' ? 'queued' : outbox.state } } };
  const parked = outbox.parked + 1;
  return { patch: { outbox: { ...outbox, parked, state: parked === outbox.moves ? 'parked' : outbox.state } } };
};

/** A link whose board records are a real board, with the table provided and the setting as given. */
function linked(t, { on, decide = table }) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  provideOutboxTable(decide, () => on);
  t.after(() => provideOutboxTable(null));
  return { board, link: { root: '/repo', localRecords: (root, work) => work(board) } };
}

test('outbox.shadow-record.off-runs-nothing: clause 3: with moves.shadow off (the default) the outbox writer runs no table and records no compare [C7,#8389]', t => {
  const { board, link } = linked(t, { on: false, decide: () => { throw new Error('the table must not run'); } });
  shadowOutbox(link, 'queue', null, doc(false), 'move-1');
  assert.equal(readShadow(board, 'outbox'), null);
});

test('outbox.shadow-record.match-counts-compare: clause 2: with moves.shadow on, a matching queue and park add one compare each and no disagreement to the outbox table\'s counts [C7,#8389]', t => {
  const { board, link } = linked(t, { on: true });
  shadowOutbox(link, 'queue', null, doc(false), 'move-1');
  shadowOutbox(link, 'queue', doc(false), doc(false, false), 'move-2');
  shadowOutbox(link, 'park', doc(false, false), doc(true, false), 'move-1');
  const counts = readShadow(board, 'outbox');
  assert.equal(counts.compared, 3);
  assert.equal(counts.disagreed, 0, `the outbox table agreed: ${JSON.stringify(counts.last)}`);
  assert.equal(counts.since, new Date(AT).toISOString());
});

test('outbox.shadow-record.differs-counts-disagreement: clause 1: with moves.shadow on, an outbox move whose table answer differs adds one disagreement naming the move and the field [C7,#8389]', t => {
  const { board, link } = linked(t, { on: true });
  shadowOutbox(link, 'queue', doc(false), doc(false), 'move-lost');
  shadowOutbox(link, 'park', doc(false), doc(true), 'move-1');
  const refusing = linked(t, { on: true, decide: () => ({ refused: { code: 'OUTBOX_ILLEGAL_MOVE' } }) });
  shadowOutbox(refusing.link, 'queue', null, doc(false), 'move-2');
  assert.deepEqual(readShadow(board, 'outbox').last.map(({ id, differs }) => ({ id, differs })), [{ id: 'move-lost', differs: 'outbox.moves' }]);
  assert.deepEqual(readShadow(refusing.board, 'outbox').last.map(({ id, differs }) => ({ id, differs })), [{ id: 'move-2', differs: 'refused' }]);
  const counts = readShadow(board, 'outbox');
  assert.deepEqual([counts.compared, counts.disagreed], [2, 1], 'the matching park was compared and agreed');
});
