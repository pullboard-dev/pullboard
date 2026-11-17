/** @pullboard-test-input packages/store/tests/fixtures/submit-outcome-records.json */
/** @pullboard-world-pin reads the recorded refusal renewals fixture to drive the submit outcome writer with it. With moves.shadow on, the outcome compare is recorded on the board when its claim commits; off, nothing is [C7,#8380]. */
/** @pullboard-test-input packages/store/tests/fixtures/submit-outcome-records.json packages/store/src/io/submit/outcome.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';

const STAMP = '2026-01-01T00:00:00.000Z';
const [record] = JSON.parse(readFileSync(new URL('../../fixtures/submit-outcome-records.json', import.meta.url), 'utf8'));

/** A real board holding the one item a recorded refusal renewal saw, on a clock at the renewal's own instant. */
function boardFor(t, snapshot, shadow) {
  const over = {};
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  if (shadow !== undefined) board.movesShadow = shadow;
  const sql = board.db;
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_item%'").all()) sql.exec(`DROP TRIGGER ${name}`);
  const { item } = snapshot;
  sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(item.owner, 'core', `/seat/${item.owner}`, 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_owner, item_lease_until, item_frozen, item_frozen_digest, item_created_by, item_created_at, item_updated_at)
    VALUES (?, 'core', 'recorded', 'strong', ?, ?, ?, 'frozen', ?, 'coordinator', ?, ?)`)
    .run(item.id, over.status ?? item.status, over.owner ?? item.owner, over.leaseUntil ?? item.leaseUntil, over.digest ?? item.frozenDigest, STAMP, STAMP);
  return board;
}


/** The recorded refusal renewal, through the outcome writer and then the claim's own commit of it. */
function renew(board) {
  const outcome = store.checkedSubmitOutcome(board, record.move.id, record.move.actor, record.renewal, null);
  store.recordPendingOutcome(outcome);
  return outcome;
}

test('clause 1: with moves.shadow on, a submit outcome whose table answer differs adds one disagreement to the recorded counts [C7,#8380]', t => {
  const board = boardFor(t, record.snapshot, true);
  const hook = store.shadowHook(board, 'submitOutcomeShadow', 'outcome', store.outcomeDiffers, () => true);
  const { id } = record.move;
  hook({ id, decided: { recorded: { ...record.renewal, code: 'OTHER' } }, wrote: { recorded: record.renewal } });
  hook({ id, decided: { skipped: true }, wrote: { recorded: record.renewal } });
  hook({ id, decided: { skipped: true }, wrote: { refused: { code: 'ITEM_LEASE_LOST' } } });
  const counts = store.readShadow(board, 'outcome');
  assert.equal(counts.compared, 3);
  assert.equal(counts.disagreed, 2, 'a claim that moved on is skipped by the table and refused by the writer: the same answer');
  assert.deepEqual(counts.last.map(({ differs }) => differs), ['recorded.code', 'skipped']);
});

test('clause 2: with moves.shadow on, a matching submit outcome adds one compare and no disagreement when its claim commits [C7,#8380]', t => {
  const board = boardFor(t, record.snapshot, true);
  const outcome = store.checkedSubmitOutcome(board, record.move.id, record.move.actor, record.renewal, null);
  assert.equal(store.readShadow(board, 'outcome'), null, 'nothing is recorded before the claim commits');
  store.recordPendingOutcome(outcome);
  const counts = store.readShadow(board, 'outcome');
  assert.equal(counts.compared, 1);
  assert.equal(counts.disagreed, 0, JSON.stringify(counts.last));
});

test('clause 3: with moves.shadow off no submit outcome compare is recorded [C7,#8380]', t => {
  const board = boardFor(t, record.snapshot);
  renew(board);
  assert.equal(store.readShadow(board, 'outcome'), null);
});
