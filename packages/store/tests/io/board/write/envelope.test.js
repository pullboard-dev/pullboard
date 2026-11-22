/** @pullboard-test-input source-cell store */
/** commitPrepared runs inside the same write envelope as logEvent: capture, write policy and review normalization [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { logEvent } from '../../../../index.js';
import { atomic } from '../../../../src/io/board/event/log.js';
import { captureBoardChanges } from '../../../../src/io/board/capture.js';
import { commitPrepared } from '../../../../src/io/board/write/sequencer.js';
import { prepareEventAppend } from '../../../../src/io/board/write/event.js';
import { ensureProofCounters } from '../../../../../verify/index.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';
import { temporaryDirectory } from '../../../fixtures/tmp.js';

const AT = new Date('2026-11-20T10:00:00.000Z');

/** A real board file with one seat and a fixed clock, and a machine home of its own for the write log. */
function fixture(t, { seat: withSeat = true } = {}) {
  const directory = temporaryDirectory('pullboard-envelope-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(directory, 'home');
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  const board = cellBoard(t, join(directory, 'board.sqlite'), { now: () => AT }, { real: true });
  const seat = withSeat ? cellSeat(board, { lane: 'core', path: '/builder' }) : null;
  return { board, seat };
}

const eventCount = board => board.db.prepare('SELECT count(*) AS n FROM event').get().n;

/** Compare every native table after applying the relay changesets, including the drained proof projection. */
function boardRows(board) {
  const tables = board.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name,
    board.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .filter(row => name !== 'board_meta' || row.meta_key !== 'board_id').map(row => JSON.stringify(row)).sort()]));
}

test('store.io-board-write-sequencer.envelope-capture: clause 1: [C7] a prepared write under captureBoardChanges produces the same relay changeset as the equivalent logEvent write', async t => {
  const logged = fixture(t, { seat: false });
  const prepared = fixture(t, { seat: false });
  const detail = { text: 'x' };
  const viaLog = await captureBoardChanges(() => logEvent(logged.board, 'not-a-seat', 'note', null, detail));
  const viaPrepared = await captureBoardChanges(() => {
    commitPrepared(prepared.board, { move: 'event-append', statements: [prepareEventAppend(prepared.board, { by: 'not-a-seat', kind: 'note', itemId: null, detail })] });
    // The prepared event commits first; the rebuildable projection catches up in its own post-commit transaction.
    atomic(prepared.board, () => ensureProofCounters(prepared.board, { refresh: false }), { move: 'proof-counter-drain', reviewPolicy: false });
  });
  assert.ok(viaLog.changes.length > 0, 'the logEvent write is captured');
  assert.equal(viaPrepared.changes.length, 2, 'the prepared event and post-commit counter drain are captured separately');
  const replayLogged = fixture(t, { seat: false }).board;
  const replayPrepared = fixture(t, { seat: false }).board;
  assert.equal(replayLogged.db.applyChangeset(viaLog.changes[0]), true, 'the relay can apply the logEvent changeset');
  for (const changeset of viaPrepared.changes) assert.equal(replayPrepared.db.applyChangeset(changeset), true, 'the relay can apply each prepared write changeset');
  assert.deepEqual(boardRows(replayPrepared), boardRows(replayLogged), 'the prepared write and drained counters reproduce every changed native row');
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
