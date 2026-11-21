/** @pullboard-test-input source-cell store */
/** commitPrepared runs inside the same write envelope as logEvent: capture, write policy and review normalization [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { logEvent } from '../../../../index.js';
import { captureBoardChanges } from '../../../../src/io/board/capture.js';
import { commitPrepared } from '../../../../src/io/board/write/sequencer.js';
import { prepareEventAppend } from '../../../../src/io/board/write/event.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';
import { temporaryDirectory } from '../../../fixtures/tmp.js';

const AT = new Date('2026-11-20T10:00:00.000Z');

/** A real board file with one seat and a fixed clock, and a machine home of its own for the write log. */
function fixture(t) {
  const directory = temporaryDirectory('pullboard-envelope-');
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

const eventCount = board => board.db.prepare('SELECT count(*) AS n FROM event').get().n;

test('store.io-board-write-sequencer.envelope-capture: clause 1: [C7] a prepared write under captureBoardChanges produces the same relay changeset as the equivalent logEvent write', async t => {
  const logged = fixture(t);
  const prepared = fixture(t);
  const detail = { text: 'x' };
  const viaLog = await captureBoardChanges(() => logEvent(logged.board, 'not-a-seat', 'note', null, detail));
  const viaPrepared = await captureBoardChanges(() => commitPrepared(prepared.board, { move: 'event-append', statements: [prepareEventAppend(prepared.board, { by: 'not-a-seat', kind: 'note', itemId: null, detail })] }));
  assert.ok(viaLog.changes.length > 0, 'the logEvent write is captured');
  assert.equal(viaPrepared.changes.length, viaLog.changes.length);
  assert.ok(viaPrepared.changes.every((changes, index) => Buffer.compare(Buffer.from(changes), Buffer.from(viaLog.changes[index])) === 0),
    `the changesets are byte-equal (${viaPrepared.changes.map(changes => changes.length)} vs ${viaLog.changes.map(changes => changes.length)})`);
});

test('store.io-board-write-sequencer.envelope-policy: clause 2: [C7] commitPrepared applies the write policy and review normalization logEvent does, and a refused write appends nothing', t => {
  const { board, seat } = fixture(t);
  const calls = [];
  const normalize = board.runtimePorts.lifecycle.normalizeReviewDefaults;
  const statement = () => prepareEventAppend(board, { by: seat.id, kind: 'note', itemId: null, detail: { text: 'p' } });
  board.runtimePorts = { ...board.runtimePorts, lifecycle: { ...board.runtimePorts.lifecycle, normalizeReviewDefaults: target => { calls.push('review'); return normalize(target); } } };
  board.prepareWritePolicy = () => ({ current: () => true, enter: () => calls.push('enter'), assertCurrent: () => calls.push('assert'), leave: () => calls.push('leave') });
  const before = eventCount(board);
  commitPrepared(board, { move: 'event-append', statements: [statement()] });
  assert.deepEqual(calls, ['enter', 'review', 'assert', 'leave']);
  assert.equal(eventCount(board), before + 1);

  board.prepareWritePolicy = () => ({ current: () => true, enter() {}, leave() {}, assertCurrent() { throw Object.assign(new Error('policy refused'), { code: 'POLICY_REFUSED' }); } });
  assert.throws(() => commitPrepared(board, { move: 'event-append', statements: [statement()] }), { code: 'POLICY_REFUSED' });
  assert.equal(eventCount(board), before + 1, 'a refused write appends nothing');
  assert.equal(board.db.isTransaction, false);
});
