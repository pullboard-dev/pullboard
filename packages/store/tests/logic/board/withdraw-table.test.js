/** @pullboard-world-pin reads the recorded withdraw history fixture to replay each withdrawal through the store withdraw writer. The store withdraw writer agrees with the withdraw table on every replayed move [C7,#8273]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { boardWithdrawEngine } from '../../../../moves/index.js';
import { readWithdrawRecords } from '../../../../moves/index.js';
import { runTable } from '../../../../moves/index.js';
import { withdraw } from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';

const HISTORY = JSON.parse(readFileSync(new URL('../../../../moves/tests/fixtures/table/withdraw-history.json', import.meta.url), 'utf8'));
const STAMP = '2026-01-01T00:00:00.000Z';

/** The recorded events on a scratch in-memory board, read the way the replay reads them. */
function recorded() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT \'{}\')');
  const event = db.prepare('INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, at, by, kind, item, detail] of HISTORY.events) event.run(id, at, by, kind, item, JSON.stringify(detail));
  return { db };
}

/** A real board holding one item in the state the record found it, walked there under the move token a board move holds while it writes. */
function boardFor(t, item) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(STAMP) });
  const sql = board.db;
  sql.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run('core-1', 'core', '/seat/core-1', 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (?, 'core', 'recorded', 'strong', 'open', 'coordinator', ?, ?)`).run(item.id, STAMP, STAMP);
  const walk = (state, fields) => { const all = { ...fields, item_status: state }; sql.prepare(`UPDATE item SET ${Object.keys(all).map(k => `${k}=?`).join(', ')} WHERE item_id=?`).run(...Object.values(all), item.id); };
  sql.exec('INSERT INTO temp.moving VALUES (1)');
  if (item.status !== 'open') walk('claimed', { item_owner: 'core-1', item_lease_until: '2099-01-01T00:00:00.000Z', item_frozen_digest: 'd'.repeat(64) });
  if (item.status === 'submitted') walk('submitted', { item_built_by: 'core-1', item_commit: 'a'.repeat(40) });
  sql.exec('DELETE FROM temp.moving');
  return board;
}

const records = readWithdrawRecords(recorded(), { since: HISTORY.since, only: HISTORY.withdraws }).withdraw;
const eventsOf = (board, before) => board.db.prepare('SELECT event_kind kind, event_by by, event_detail detail FROM event WHERE event_id>? ORDER BY event_id').all(before)
  .filter(e => e.kind !== 'shout').map(e => { const { model, ...detail } = JSON.parse(e.detail); return { kind: e.kind, by: e.by, detail }; });

test('clause 1: the store withdraw writer agrees with the withdraw table on every replayed withdrawal [C7,#8273]', t => {
  const { rules, table } = boardWithdrawEngine();
  assert.ok(records.length >= 30, 'the replay holds the board\'s withdrawals');
  const disagreements = [];
  for (const record of records) {
    const answer = runTable(table, rules, structuredClone(record.snapshot), structuredClone(record.move));
    const board = boardFor(t, record.snapshot.item);
    const before = board.db.prepare('SELECT COALESCE(MAX(event_id),0) id FROM event').get().id;
    withdraw(board, record.move.id, { agentId: record.move.actor, reason: record.move.reason });
    const wrote = eventsOf(board, before);
    if (JSON.stringify(wrote) !== JSON.stringify(answer.events) || JSON.stringify(wrote) !== JSON.stringify(record.recorded.events)) disagreements.push({ event: record.event.id, wrote, expected: answer.events });
  }
  assert.deepEqual(disagreements, []);
});

test('clause 1: the writer refuses with the table\'s code and words in the order the move declares, and writes nothing [C7,#8273]', t => {
  const record = records[0];
  const board = boardFor(t, record.snapshot.item);
  const count = () => board.db.prepare('SELECT COUNT(*) n FROM event').get().n;
  const before = count();
  const id = record.move.id;
  assert.throws(() => withdraw(board, id, { agentId: 'core-1', reason: ' ' }), { code: 'COORDINATOR_ONLY', message: '[COORDINATOR_ONLY] only the coordinator withdraws items' });
  assert.throws(() => withdraw(board, id, { agentId: 'coordinator', reason: ' ' }), { code: 'NOTE_REQUIRED' });
  assert.throws(() => withdraw(board, 999999, { agentId: 'coordinator', reason: 'gone' }), { code: 'NO_ITEM' });
  assert.equal(count(), before);
  withdraw(board, id, { agentId: 'coordinator', reason: 'duplicate' });
  assert.throws(() => withdraw(board, id, { agentId: 'coordinator', reason: 'again' }), { code: 'CLOSED', message: `[CLOSED] item #${id} is withdrawn` });
});
