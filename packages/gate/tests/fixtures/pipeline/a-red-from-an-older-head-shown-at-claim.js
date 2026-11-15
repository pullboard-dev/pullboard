/**
 * Invariant: a red gate is handed back at claim only when it ran on the item's current commit; a red from an older
 * head proves nothing about the new work and is never shown [C7].
 * Repro: returnedRecord showed the newest red or infrastructure gate whatever commit it ran on, so a builder who had
 * since moved the item to a new head was told to fix a refusal from the old one. gateAtHead already matched the commit.
 * Runs on a real Git repository and a real SQLite board; the red record is the gate job's own step.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { createJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';
import { from } from './kit.js';
import { hopCheck } from './kit.js';

// Neither is on the store front door, so the harness loads them by path like the other pipeline harnesses.
const { returnedRecord, gateAtHead } = await from('packages/store/src/io/board/next.js');
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

/** A claimed item with a red gate recorded at the OLD commit, and the item's own submitted commit set by the caller. */
function redAt(t, itemCommit) {
  const repo = cellRepo(t);
  const board = cellBoard(t, repo.boardFile, undefined, { gitRoot: repo.root });
  const seat = cellSeat(board, { lane: 'web', path: repo.root });
  const item = cellItem(board, { lane: 'web', title: 'Red page', criterion: 'The page renders.', specIds: ['G1'], check: 'true' });
  const id = item.item_id;
  cellClaim(board, id, seat, { root: repo.root });
  const claimed = board.db.prepare('SELECT * FROM item WHERE item_id = ?').get(id);
  board.db.prepare('UPDATE item SET item_commit = ? WHERE item_id = ?').run(itemCommit, id);
  const now = Date.now();
  createJob(board.db, { id: `gate:${id}`, kind: 'gate', item: id, candidate: OLD, now });
  const record = { id: `gate:${id}`, state: 'red', agentId: seat.id, digest: claimed.item_frozen_digest, commit: OLD,
    error: { code: 'GATE_RED', message: 'the page did not render', next: 'fix it' } };
  writeStep(board.db, `gate:${id}`, 'done', { record }, { now });
  return { board, id };
}

test('a red at the item\'s current commit is shown at claim [C7]', async t => {
  await hopCheck('red-at-head', async () => {
    const { board, id } = redAt(t, OLD);
    const shown = returnedRecord(board, id);
    assert.equal(shown?.gate?.code, 'GATE_RED', 'the red for the current commit is handed back');
    assert.equal(shown.gate.commit, OLD);
    return { measured: 'the red for the current commit was handed back' };
  });
});

test('a red from an older head is not shown once the item moved to a new commit [C7]', async t => {
  await hopCheck('red-older-head', async () => {
    const { board, id } = redAt(t, NEW);
    assert.equal(returnedRecord(board, id), null, 'no red is handed back for a head the gate never ran');
    assert.equal(gateAtHead(board, board.db.prepare('SELECT * FROM item WHERE item_id = ?').get(id)), null, 'gateAtHead agrees');
    return { measured: 'no red was handed back for a head the gate never ran' };
  });
});
