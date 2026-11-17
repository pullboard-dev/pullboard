/** @pullboard-test-input source-cell packages/moves */
/** @pullboard-world-pin reads the recorded withdraw and reopen history fixture to replay it through the tables. The withdraw and reopen tables replay moves recorded on a real board with zero disagreements, and refuse what the board refuses [C7,#8258]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { REOPEN_NEXT } from '../../../index.js';
import { WITHDRAW_NEXT } from '../../../index.js';
import { boardReopenEngine } from '../../../index.js';
import { boardWithdrawEngine } from '../../../index.js';
import { readWithdrawRecords } from '../../../index.js';
import { reopenEngine } from '../../../index.js';
import { replayTable } from '../../../index.js';
import { runTable } from '../../../index.js';
import { withdrawEngine } from '../../../index.js';

const HISTORY = JSON.parse(readFileSync(new URL('../../fixtures/table/withdraw-history.json', import.meta.url), 'utf8'));
const WITHDRAW = boardWithdrawEngine();
const REOPEN = boardReopenEngine();

/** The recorded events on an in-memory board, shaped as the real board stores them. */
function recordedBoard() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT \'{}\')');
  const event = db.prepare('INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, at, by, kind, item, detail] of HISTORY.events) event.run(id, at, by, kind, item, JSON.stringify(detail));
  return { db };
}

const records = readWithdrawRecords(recordedBoard(), { since: HISTORY.since, only: [...HISTORY.withdraws, ...HISTORY.reopens] });

test('clause 1: replaying recorded board history through the withdraw and reopen tables gives zero disagreements [C7,#8258]', () => {
  const withdraw = replayTable(WITHDRAW.table, WITHDRAW.rules, records.withdraw, { cut: HISTORY.since });
  const reopen = replayTable(REOPEN.table, REOPEN.rules, records.reopen, { cut: HISTORY.since });
  assert.deepEqual(withdraw.disagreements, []);
  assert.deepEqual(reopen.disagreements, []);
  assert.deepEqual([withdraw.total, withdraw.agreed, withdraw.notReplayable], [HISTORY.withdraws.length, HISTORY.withdraws.length, 0]);
  assert.deepEqual([reopen.total, reopen.agreed, reopen.notReplayable], [records.reopen.length, records.reopen.length, 0]);
  assert.ok(withdraw.agreed >= 30 && reopen.agreed >= 8, 'the fixture holds a few of each recorded path');
});

test('clause 1: the replay covers every withdraw and reopen path the board used [C7,#8258]', () => {
  const via = new Set();
  for (const record of records.withdraw) via.add(runTable(WITHDRAW.table, WITHDRAW.rules, structuredClone(record.snapshot), structuredClone(record.move)).via[0]);
  for (const record of records.reopen) via.add(runTable(REOPEN.table, REOPEN.rules, structuredClone(record.snapshot), structuredClone(record.move)).via[0]);
  for (const path of ['withdraw', 'return-submission', 'return-conflict', 'return-landing-failure', 'withdraw-verdict']) assert.ok(via.has(path), `${path} replayed`);
  assert.deepEqual([...new Set(records.withdraw.map(record => record.snapshot.item.status))].sort(), ['claimed', 'open', 'submitted']);
});

test('clause 1: a recorded move replayed with one captured fact broken is a disagreement the replay names [C7,#8258]', () => {
  const stranger = { ...structuredClone(records.withdraw[0]), move: { ...structuredClone(records.withdraw[0].move), actor: 'someone-else' } };
  assert.deepEqual(replayTable(WITHDRAW.table, WITHDRAW.rules, [stranger], { cut: HISTORY.since }).disagreements.map(entry => entry.table.code), ['COORDINATOR_ONLY']);
  const merged = { ...structuredClone(records.reopen[0]), snapshot: { ...structuredClone(records.reopen[0].snapshot), item: { ...records.reopen[0].snapshot.item, status: 'merged' } } };
  assert.deepEqual(replayTable(REOPEN.table, REOPEN.rules, [merged], { cut: HISTORY.since }).disagreements.map(entry => entry.table.code), ['NOT_SUBMITTED']);
});

test('clause 1: the withdraw table refuses in the order the command throws, with its words [C7,#8258]', () => {
  const record = records.withdraw[0];
  const refuse = (move, snapshot = record.snapshot) => runTable(WITHDRAW.table, WITHDRAW.rules, structuredClone(snapshot), { ...structuredClone(record.move), ...move }).refused;
  assert.equal(refuse({ actor: 'core-1', reason: ' ' }).code, 'COORDINATOR_ONLY');
  assert.equal(refuse({ reason: ' ' }).code, 'NOTE_REQUIRED');
  assert.deepEqual(refuse({ id: 999 }, { ...record.snapshot, item: null }), { code: 'NO_ITEM', message: 'no item #999; see: pullboard list', next: WITHDRAW_NEXT.NO_ITEM, row: 'item-exists', fact: 'itemExists', trace: [{ fact: 'itemExists', holds: false }] });
  assert.equal(refuse({}, { ...record.snapshot, item: { ...record.snapshot.item, status: 'withdrawn' } }).message, `item #${record.move.id} is withdrawn`);
  assert.equal(refuse({ expected: { status: 'open' } }).code, 'STALE_MAIN_RED');
  assert.equal(refuse({}, { ...record.snapshot, actor: { id: 'x', joined: false } }).code, 'NOT_JOINED');
  assert.throws(() => withdrawEngine({ from: [] }), { code: 'WITHDRAW_TABLE_INPUTS' });
  assert.throws(() => reopenEngine({}), { code: 'REOPEN_TABLE_INPUTS' });
});

test('clause 1: a Main red audit withdrawal writes the cause fact the board derives, and refuses a changed item [C7,#8258]', () => {
  const frozen = JSON.stringify({ title: 'Main red: x', check: 'node --test a.js' });
  const digest = createHash('sha256').update(frozen).digest('hex');
  const expected = { status: 'open', title: 'Main red: x', check: 'node --test a.js', frozenDigest: digest, head: 'a'.repeat(40) };
  const item = { id: 5, status: 'open', title: 'Main red: x', check: 'node --test a.js', frozen, frozenDigest: digest };
  const run = (found) => runTable(WITHDRAW.table, WITHDRAW.rules, { actor: { id: 'coordinator', joined: true }, item: found }, { id: 5, actor: 'coordinator', reason: 'fixed', expected });
  const done = run(item);
  assert.deepEqual(done.events.map(event => event.kind), ['withdraw', 'fact']);
  assert.match(done.events[1].detail.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(done.events[1].detail.text, `Fixed on main by ${'a'.repeat(40)}; every file named in the frozen check passed in the current-tip audit.`);
  assert.equal(run({ ...item, title: 'Main red: y' }).refused.code, 'STALE_MAIN_RED');
});

test('clause 1: the reopen table refuses in the order the command throws, with its words [C7,#8258]', () => {
  const record = records.reopen.find(entry => entry.snapshot.item.status === 'submitted' && !entry.move.conflict && !entry.move.withdrawVerdict);
  const refuse = (move, snapshot = record.snapshot) => runTable(REOPEN.table, REOPEN.rules, structuredClone(snapshot), { ...structuredClone(record.move), ...move }).refused;
  assert.equal(refuse({ actor: 'core-1' }).code, 'COORDINATOR_ONLY');
  assert.equal(refuse({ note: ' ' }).code, 'NOTE_REQUIRED');
  assert.equal(refuse({ cause: 'nonsense' }).code, 'BAD_CAUSE');
  const verified = { ...record.snapshot, item: { ...record.snapshot.item, status: 'verified' } };
  assert.equal(refuse({}, verified).code, 'LANDING_FAILURE_REQUIRED');
  assert.equal(refuse({}, { ...verified, item: { ...verified.item, mergedCommit: 'a'.repeat(40) } }).code, 'ALREADY_MERGED');
  assert.equal(refuse({ conflict: { files: ['a.js'], trunk: 'b'.repeat(40) } }, { ...record.snapshot, conflict: { accepted: false } }).code, 'CONFLICT_FILES');
  assert.equal(refuse({}, { ...record.snapshot, item: null }).code, 'NO_ITEM');
  assert.equal(refuse({}, { ...record.snapshot, item: { ...record.snapshot.item, status: 'open' } }).message, `item #${record.move.id} is open, not submitted`);
  assert.equal(REOPEN_NEXT.NOT_SUBMITTED.startsWith('see its state'), true);
});
