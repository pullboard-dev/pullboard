/** @pullboard-test-input packages/store/tests/fixtures/submit-outcome-records.json */
/** @pullboard-world-pin reads the recorded refusal renewals fixture to drive the submit outcome writer with it. The store submit writer applies the submit table and agrees on every replayed move [C7,#8271]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkedSubmitOutcome } from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';

/** The refusal renewals the board recorded, each with the state it saw; built from the submit history by the moves cell's replay. */
const outcomes = JSON.parse(readFileSync(new URL('../../../../../store/tests/fixtures/submit-outcome-records.json', import.meta.url), 'utf8'));
const STAMP = '2026-01-01T00:00:00.000Z';

/** A real board holding the one item a recorded refusal renewal saw, on a clock at the renewal's own instant. */
function boardFor(t, snapshot, over = {}) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  const sql = board.db;
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_item%'").all()) sql.exec(`DROP TRIGGER ${name}`);
  const { item } = snapshot;
  sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(item.owner, 'core', `/seat/${item.owner}`, 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_owner, item_lease_until, item_frozen, item_frozen_digest, item_created_by, item_created_at, item_updated_at)
    VALUES (?, 'core', 'recorded', 'strong', ?, ?, ?, 'frozen', ?, 'coordinator', ?, ?)`)
    .run(item.id, over.status ?? item.status, over.owner ?? item.owner, over.leaseUntil ?? item.leaseUntil, over.digest ?? item.frozenDigest, STAMP, STAMP);
  return board;
}

/** Run the writer on a board that shadows it: the table's answer and what the writer did. */
function drive(board, record, value = record.renewal) {
  const seen = [];
  board.submitOutcomeShadow = (answer) => seen.push(answer);
  const { id, actor } = record.move;
  let threw = null;
  let returned;
  try { returned = checkedSubmitOutcome(board, id, actor, value, null); } catch (error) { threw = error; }
  assert.equal(seen.length, 1, 'the writer ran the table once');
  return { seen: seen[0], returned, threw };
}

test('board.submit-outcome-table.the-store-submit-writer-applies-the: clause 1: the store submit writer applies the submit table and agrees on every replayed move [C7,#8271]', t => {
  assert.equal(outcomes.length, 2, 'the replay holds the board\'s two refusal renewals');
  for (const record of outcomes) {
    const { seen, returned, threw } = drive(boardFor(t, record.snapshot), record);
    assert.equal(threw, null);
    assert.deepEqual(seen.decided, { recorded: record.renewal }, 'the table records what the board recorded');
    assert.deepEqual(seen.wrote, { recorded: returned }, 'the writer reports what it returned');
    assert.deepEqual(JSON.parse(JSON.stringify(returned)), record.renewal, 'the writer records what the board recorded');
  }
});

test('board.submit-outcome-table.renewal-claim-that-moved-skipped-the: clause 1: a renewal on a claim that moved on is skipped by the table and refused by the writer [C7,#8271]', t => {
  const [record] = outcomes;
  const moved = { owner: 'someone-else' };
  const expired = { leaseUntil: '2000-01-01T00:00:00.000Z' };
  const rebarred = { digest: 'f'.repeat(64) };
  const released = { status: 'open' };
  for (const over of [moved, expired, rebarred, released]) {
    const { seen, threw } = drive(boardFor(t, record.snapshot, over), record);
    assert.deepEqual(seen.decided, { skipped: true }, JSON.stringify(over));
    assert.equal(threw.code, 'ITEM_LEASE_LOST', JSON.stringify(over));
    assert.deepEqual(seen.wrote.refused.code, 'ITEM_LEASE_LOST');
  }
});

test('board.submit-outcome-table.malformed-refusal-refused-both-the-table: clause 1: a malformed refusal is refused by both the table and the writer [C7,#8271]', t => {
  const [record] = outcomes;
  for (const bad of [{ ...record.renewal, code: 'lower' }, { ...record.renewal, text: '   ' }]) {
    const { seen, threw } = drive(boardFor(t, record.snapshot), record, bad);
    assert.equal(seen.decided.refused.code, 'USAGE');
    assert.equal(threw.code, 'USAGE');
  }
});
