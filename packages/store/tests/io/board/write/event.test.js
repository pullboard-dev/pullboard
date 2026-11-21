/** @pullboard-test-input source-cell store */
/** One board event becomes a prepared statement that commitPrepared appends exactly as logEvent does [C7,R2]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { logEvent } from '../../../../index.js';
import { commitPrepared } from '../../../../src/io/board/write/sequencer.js';
import { prepareEventAppend } from '../../../../src/io/board/write/event.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';
import { temporaryDirectory } from '../../../fixtures/tmp.js';

const AT = new Date('2026-11-20T10:00:00.000Z');

/** A real board file with one seat and a fixed clock, and a machine home of its own for the write log. */
function fixture(t) {
  const directory = temporaryDirectory('pullboard-event-prepared-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(directory, 'home');
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  const board = cellBoard(t, join(directory, 'board.sqlite'), { now: () => AT }, { real: true });
  const seat = cellSeat(board, { lane: 'core', path: '/builder' });
  return { board, seat };
}

const row = (board, id) => board.db.prepare('SELECT * FROM event WHERE event_id = ?').get(id);

test('store.io-board-write-event.same-row-as-log-event: clause 1: [C7] a prepared event commits the row logEvent writes, with the next event_id, the same fields and the seat model in its detail', t => {
  const { board, seat } = fixture(t);
  for (const [by, itemId, detail] of [[seat.id, null, { text: 'x' }], ['not-a-seat', null, { text: 'y' }], [seat.id, 7, {}]]) {
    const logged = logEvent(board, by, 'note', itemId, detail);
    const prepared = prepareEventAppend(board, { by, kind: 'note', itemId, detail });
    const [result] = commitPrepared(board, { move: 'event-append', statements: [prepared] });
    assert.equal(Number(result.lastInsertRowid), logged.event_id + 1);
    assert.deepEqual({ ...row(board, Number(result.lastInsertRowid)), event_id: logged.event_id }, row(board, logged.event_id));
  }
  assert.equal(JSON.parse(row(board, 1).event_detail).model !== undefined, true);
  const explicit = prepareEventAppend(board, { by: seat.id, kind: 'note', itemId: null, at: new Date('2026-01-02T03:04:05.000Z') });
  assert.equal(explicit.params[0], '2026-01-02T03:04:05.000Z');
});

test('store.io-board-write-event.refuses-before-write: clause 2: [C7] a refused build writes nothing and a failed commit appends no event', t => {
  const { board, seat } = fixture(t);
  const before = board.db.prepare('SELECT count(*) AS n FROM event').get().n;
  board.executionEngineVersion = 1;
  assert.throws(() => prepareEventAppend(board, { by: seat.id, kind: 'pulled', itemId: null }), { code: 'ENGINE_VERSION' });
  assert.throws(() => logEvent(board, seat.id, 'pulled', null), { code: 'ENGINE_VERSION' });
  delete board.executionEngineVersion;
  assert.throws(() => commitPrepared(board, { move: 'event-fail', statements: [
    prepareEventAppend(board, { by: seat.id, kind: 'note', itemId: null, detail: { text: 'kept out' } }),
    { sql: 'INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)', params: [null, null, null, null, null] },
  ] }));
  assert.equal(board.db.prepare('SELECT count(*) AS n FROM event').get().n, before, 'the failed commit left no event behind');
  assert.equal(board.db.isTransaction, false);
});
