/** @pullboard-test-input packages/store/src/io/board/write.js packages/store/src/io/board/edit.js */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { editItem } from '../../index.js';
import { getItem } from '../../index.js';
import { writeBoardCommand } from '../../index.js';
import { cellBoard } from '../fixtures/cell.js';
import { cellItem } from '../fixtures/cell.js';
import { cellSandbox } from '../fixtures/cell.js';

/** A real board file, so a second connection can see whether the board's write lock is held. */
function fixture(t) {
  const file = join(cellSandbox(t).dir, 'board.sqlite');
  const board = cellBoard(t, file, undefined, { real: true });
  const id = cellItem(board, { lane: 'web', title: 'Corrected item', specIds: ['G1'], criterion: 'Corrected item works', check: 'true' }).item_id;
  const probe = new DatabaseSync(file);
  t.after(() => probe.close());
  probe.exec('PRAGMA busy_timeout = 0');
  /** Whether another connection is refused the write lock right now. */
  const writeHeld = () => {
    try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); return false; }
    catch (error) { if (/locked|busy/iu.test(error.message)) return true; throw error; }
  };
  return { board, id, writeHeld };
}

/** A freeze that records each call and whether the write lock was held, and whose text names the brief it saw. */
function recordingFreeze(writeHeld, onCall = () => {}) {
  const calls = [];
  const freeze = item => {
    calls.push({ held: writeHeld(), brief: item.item_brief });
    onCall(calls.length);
    const text = JSON.stringify({ criterion: item.item_criterion, check: item.item_check, brief: item.item_brief, call: calls.length });
    return { text, digest: createHash('sha256').update(text).digest('hex') };
  };
  return { calls, freeze };
}

test('clause 1: a coordinator criterion edit runs its freezer before the board write opens [C7]', t => {
  const { board, id, writeHeld } = fixture(t);
  const { calls, freeze } = recordingFreeze(writeHeld);
  writeBoardCommand(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'Corrected item works under load', correction: true, freeze }], 'coordinator');
  assert.deepEqual(calls.map(call => call.held), [false], 'the freezer ran once, with no write lock held');
  const item = getItem(board, id);
  assert.equal(item.item_criterion, 'Corrected item works under load');
  assert.equal(JSON.parse(item.item_frozen).call, 1, 'the writer stored the bar frozen before the write opened');
});

test('clause 2: an item row changed after preparation is frozen again under the lock [C7]', t => {
  const { board, id, writeHeld } = fixture(t);
  const { calls, freeze } = recordingFreeze(writeHeld, count => {
    // Another writer changes the item between preparation and the write.
    if (count === 1) editItem(board, id, { agentId: 'coordinator', brief: 'changed meanwhile' });
  });
  writeBoardCommand(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'Corrected item works again', correction: true, freeze }], 'coordinator');
  assert.deepEqual(calls.map(call => call.held), [false, true], 'the stale preparation froze again with the lock held');
  const frozen = JSON.parse(getItem(board, id).item_frozen);
  assert.equal(frozen.call, 2, 'the newer frozen bar is the one stored');
  assert.equal(frozen.brief, 'changed meanwhile');
});
