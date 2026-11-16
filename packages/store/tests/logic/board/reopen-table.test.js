/** @pullboard-world-pin reads the recorded reopens fixture, each with the reopen table's answer, to drive the store reopen writer with them. The store reopen writer applies the reopen table and agrees with it on every replayed reopen [C7,#8285]. */
/** @pullboard-test-input packages/store/tests/fixtures/reopen-records.json */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';

/** The board's recorded reopens, each with the item state it saw and the events the reopen table answered; built from the moves cell's reopen replay, whose own test proves the table agrees with the board's record. */
const RECORDS = JSON.parse(readFileSync(new URL('../../fixtures/reopen-records.json', import.meta.url), 'utf8'));
const STAMP = '2026-01-01T00:00:00.000Z';

/** A real board, with the reopen writer applying the table, holding one item in the state the record found it, with the accept, the verdict and the landing batch the record leaned on. */
function boardFor(t, record, { builder = false } = {}) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(STAMP) });
  board.movesLive = { reopen: true };
  const sql = board.db;
  const { item } = record;
  sql.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run('core-1', 'core', '/seat/core-1', 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (?, 'core', 'recorded', 'strong', 'open', 'coordinator', ?, ?)`).run(item.id, STAMP, STAMP);
  const walk = (state, fields) => { const all = { ...fields, item_status: state }; sql.prepare(`UPDATE item SET ${Object.keys(all).map(k => `${k}=?`).join(', ')} WHERE item_id=?`).run(...Object.values(all), item.id); };
  if (record.accepted !== undefined) sql.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_commit, verdict_digest, verdict_head, verdict_at) VALUES (?, 'verifier-1', 'ACCEPT', 'ok', ?, ?, ?, ?)`).run(item.id, item.commit, 'd'.repeat(64), item.commit, STAMP);
  sql.exec('INSERT INTO temp.moving VALUES (1)');
  walk('claimed', { item_owner: 'core-1', item_lease_until: '2099-01-01T00:00:00.000Z', item_frozen_digest: 'd'.repeat(64) });
  walk('submitted', { item_built_by: builder ? 'core-1' : 'builder', item_commit: item.commit });
  if (item.status === 'verified') walk('verified', { item_verified_by: 'verifier-1' });
  sql.exec('DELETE FROM temp.moving');
  const event = sql.prepare('INSERT INTO event (event_id, event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?, ?)');
  if (record.accepted !== undefined) {
    event.run(record.accepted, STAMP, 'verifier-1', 'accept', item.id, JSON.stringify({ commit: item.commit }));
  }
  if (record.failure) event.run(record.accepted + 1, STAMP, 'coordinator', 'landing_batch', null, JSON.stringify({ batch: { id: record.failure.batch, culprits: [{ id: item.id, commit: item.commit, mergeCommit: record.failure.mergeCommit, tests: record.failure.tests }] } }));
  return board;
}

/** The reopen events the writer wrote, as kind, author and parsed detail. */
const reopens = board => board.db.prepare("SELECT event_by by, event_detail detail FROM event WHERE event_kind='reopen' ORDER BY event_id").all().map(({ by, detail }) => ({ kind: 'reopen', by, detail: JSON.parse(detail) }));

/** Reopen the item as the record did. */
const reopenAs = (board, record, extra = {}) => store.reopen(board, record.item.id, { agentId: 'coordinator', note: record.move.note, conflict: record.move.conflict, withdrawVerdict: record.move.withdrawVerdict, ...extra });

test('clause 1: the store reopen writer agrees with the reopen table on every replayed reopen [C7,#8285]', t => {
  assert.ok(RECORDS.length >= 8, 'the replay holds the board\'s reopens');
  assert.deepEqual([...new Set(RECORDS.map(record => record.via))].sort(), ['return-conflict', 'return-landing-failure', 'return-submission', 'withdraw-verdict'], 'every path the board used is replayed');
  const disagreements = [];
  for (const record of RECORDS) {
    const board = boardFor(t, record);
    reopenAs(board, record);
    const wrote = reopens(board);
    const decided = record.table.map(({ kind, by, detail }, at) => ({ kind, by, detail: Object.fromEntries(Object.keys(detail).map(key => [key, wrote[at]?.detail[key]])) }));
    try { assert.deepEqual(decided, record.table); } catch { disagreements.push({ event: record.event, wrote, expected: record.table }); }
  }
  assert.deepEqual(disagreements, []);
});

test('clause 1: a conflict, landing-failure or verdict-withdrawal reopen records the first-refusal window its table decides, and a plain return records none [C7,#8285]', t => {
  const seen = {};
  for (const record of RECORDS) {
    if (seen[record.via]) continue;
    const board = boardFor(t, record, { builder: true });
    reopenAs(board, record, { reopenFirstRefusalMinutes: 30 });
    seen[record.via] = reopens(board)[0].detail.reopenFirstRefusal;
  }
  assert.equal(seen['return-submission'], undefined);
  for (const via of ['return-conflict', 'return-landing-failure', 'withdraw-verdict']) assert.deepEqual(Object.keys(seen[via]), ['builder', 'until'], `${via} reserves the item for its builder`);
});

test('clause 1: a conflict reopen records the conflict and the derived cause its table decides [C7,#8285]', t => {
  const record = RECORDS.find(entry => entry.via === 'return-conflict');
  const board = boardFor(t, record);
  reopenAs(board, record);
  const [{ detail }] = reopens(board);
  assert.deepEqual(detail.conflict, record.move.conflict);
  assert.equal(detail.cause, 'conflict:' + encodeURI(record.move.conflict.files[0]), 'the cause the board derived wins over the conflict\'s own');
});
