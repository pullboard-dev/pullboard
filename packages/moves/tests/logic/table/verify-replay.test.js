/** @pullboard-world-pin reads the recorded verdict history fixture to replay it through the verify table. The verify table replays accepts and rejects recorded on a real board with zero disagreements, and refuses what the board refuses [C7,#8248]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { VERIFY_NEXT } from '../../../index.js';
import { VERIFY_WORDS } from '../../../index.js';
import { boardVerifyEngine } from '../../../index.js';
import { readVerifyRecords } from '../../../index.js';
import { replayTable } from '../../../index.js';
import { runTable } from '../../../index.js';
import { verify } from '../../../index.js';
import { verifyEngine } from '../../../index.js';

const HISTORY = JSON.parse(readFileSync(new URL('../../fixtures/table/verify-history.json', import.meta.url), 'utf8'));
const VERIFY = boardVerifyEngine();

/** The recorded events, verdicts and items on an in-memory board, shaped as the real board stores them. */
function recordedBoard() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agent (agent_id TEXT PRIMARY KEY, agent_route TEXT);
    CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_frozen TEXT, item_frozen_digest TEXT, item_lane TEXT);
    CREATE TABLE verdict (verdict_id INTEGER PRIMARY KEY, item_id INTEGER, verdict_by TEXT, verdict_decision TEXT, verdict_reason TEXT, verdict_note TEXT, verdict_commit TEXT,
      verdict_digest TEXT, verdict_head TEXT, verdict_verifier_family TEXT, verdict_at TEXT);
    CREATE TABLE shout (shout_id INTEGER PRIMARY KEY, shout_to TEXT, shout_text TEXT, shout_decision INTEGER);
    CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT)`);
  const insert = (table, rows) => { for (const row of rows) db.prepare(`INSERT INTO ${table} VALUES (${row.map(() => '?').join(',')})`).run(...row); };
  insert('event', HISTORY.events);
  insert('agent', HISTORY.agents);
  insert('item', HISTORY.items);
  insert('verdict', HISTORY.verdictRows);
  insert('shout', HISTORY.shouts);
  insert('board_meta', HISTORY.meta);
  return { db };
}

const records = readVerifyRecords(recordedBoard(), { since: HISTORY.since, only: HISTORY.verdicts });
const run = (record, move = {}, snapshot = record.snapshot) => runTable(VERIFY.table, VERIFY.rules, structuredClone(snapshot), { ...structuredClone(record.move), ...move });

test('clause 1: replaying recorded board history through the verify accept and reject table gives zero disagreements [C7,#8248]', () => {
  const report = replayTable(VERIFY.table, VERIFY.rules, records.verify, { cut: HISTORY.since });
  assert.deepEqual(report.disagreements, []);
  assert.deepEqual([report.total, report.agreed, report.notReplayable], [records.verify.length, records.verify.length, 0]);
  assert.deepEqual([HISTORY.verdicts.length, report.agreed, records.unreplayable.length], [HISTORY.verdicts.length, HISTORY.verdicts.length - records.unreplayable.length, records.unreplayable.length]);
  // The verdict row the board kept is the one the table writes, id, note, digest and all.
  for (const record of records.verify) assert.deepEqual(run(record).patch.verdictRow, record.recorded.verdictRow, `verdict row of event ${record.event.id}`);
});

test('clause 1: the replay covers accepts, rejects and every automatic follow-up the board wrote [C7,#8248]', () => {
  const via = new Set();
  for (const record of records.verify) for (const step of run(record).via) via.add(step);
  for (const path of ['accept', 'reject', 'bar-sharpen', 'route-calibration', 'two-rejects']) assert.ok(via.has(path), `${path} replayed`);
  const kinds = new Set(records.verify.flatMap(record => record.recorded.events.map(event => event.kind)));
  for (const kind of ['accept', 'reject', 'hold_item', 'bar-sharpen', 'escalate', 'strong-rejection-notice', 'shout']) assert.ok(kinds.has(kind), `${kind} written`);
});

test('clause 1: a recorded verdict replayed with one captured fact broken is a disagreement the replay names [C7,#8248]', () => {
  const accept = records.verify.find(record => record.move.decision === 'ACCEPT' && record.snapshot.item.builtBy);
  const own = { ...structuredClone(accept), move: { ...structuredClone(accept.move), actor: accept.snapshot.item.builtBy } };
  const report = replayTable(VERIFY.table, VERIFY.rules, [own], { cut: HISTORY.since });
  assert.deepEqual(report.disagreements.map(entry => [entry.event, entry.table.code, entry.differs]), [[accept.event.id, 'SELF_VERIFY', 'decision']]);
  const reject = records.verify.find(record => record.move.decision === 'REJECT' && !record.barAdjusted);
  const quiet = { ...structuredClone(reject), move: { ...structuredClone(reject.move), reason: 'OTHER' } };
  assert.deepEqual(replayTable(VERIFY.table, VERIFY.rules, [quiet], { cut: HISTORY.since }).disagreements.map(entry => entry.differs), ['detail']);
});

test('clause 1: the verify table refuses in the order the command checks, with its words and next steps [C7,#8248]', () => {
  const accept = records.verify.find(record => record.move.decision === 'ACCEPT' && !record.snapshot.item.builtBy?.startsWith('core-0'));
  const reject = records.verify.find(record => record.move.decision === 'REJECT' && !record.barAdjusted);
  const refuse = (record, move, snapshot) => run(record, move, snapshot).refused;
  assert.deepEqual(refuse(accept, { decision: 'MAYBE' }), { code: 'USAGE', message: VERIFY_WORDS.usage, next: 'run pullboard help', row: 'decision-known', fact: 'decision-known', trace: [{ fact: 'decision-known', holds: false }] });
  assert.equal(refuse(accept, {}, { ...accept.snapshot, item: null }).code, 'NO_ITEM');
  assert.equal(refuse(accept, {}, { ...accept.snapshot, item: { ...accept.snapshot.item, status: 'open' } }).next, VERIFY_NEXT.NOT_SUBMITTED);
  assert.equal(refuse(accept, { digest: 'moved' }).message, VERIFY_WORDS.criteriaMoved);
  assert.equal(refuse(accept, { note: ' ' }).code, 'PROOF_REQUIRED');
  assert.equal(refuse(accept, { actor: accept.snapshot.item.builtBy }).message, VERIFY_WORDS.selfVerify);
  assert.equal(refuse(reject, { reason: 'NOPE' }).code, 'BAD_REASON');
  assert.match(refuse(reject, { reason: 'NOPE' }).message, /TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD, OTHER/u);
  assert.equal(refuse(reject, { note: '' }).code, 'NOTE_REQUIRED');
  assert.equal(refuse(reject, { cause: 'because' }).code, 'BAD_CAUSE');
  assert.equal(refuse(reject, { clause: '' }).next, VERIFY_NEXT.BAR_CLAUSE_REQUIRED);
  assert.equal(refuse(reject, { clause: 'a requirement the bar never states' }).next, `read pullboard show ${reject.move.id}, then quote the failing requirement with --clause`);
  assert.equal(refuse(accept, {}, { ...accept.snapshot, io: { ...accept.snapshot.io, checkRefused: { code: 'CHECK_RED', message: 'the frozen check is red', next: 'fix it' } } }).next, 'fix it');
  assert.equal(refuse(accept, {}, { ...accept.snapshot, io: { ...accept.snapshot.io, policyRefused: { code: 'BAD_CONFIG', message: 'pullboard.json does not parse' } } }).code, 'BAD_CONFIG');
  assert.throws(() => verifyEngine({ acceptReason: 'CRITERION_MET', rejectReasons: [] }), { code: 'VERIFY_TABLE_INPUTS' });
});

test('clause 1: the verify command declaration reads its next steps from the table [C7,#8248]', () => {
  for (const [code, step] of Object.entries(VERIFY_NEXT)) assert.equal(verify.nextSteps[code], step, `${code} step`);
  assert.equal(Object.keys(VERIFY_NEXT).length, 20);
});
