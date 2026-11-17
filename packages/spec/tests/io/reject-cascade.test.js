/** @pullboard-test-input source-cell spec */
/** Rejecting a spec row writes a needs-review event for each row that serves it, only with spec.cascadeReject on [C7,#9341]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { parseSpec } from '../../index.js';
import { recordRowVerification } from '../../index.js';

const SOURCE = '- F2 [approved, must] Fact two holds. | gate: review';
const SPEC_ROWS = [
  { id: 'F2', serves: [] },
  { id: 'I1', serves: ['F2'] },
  { id: 'I3', serves: ['I1'] },
  { id: 'X9', serves: [] },
];

/** Record a rejection of F2 by an outside-parent verifier on a fresh board and return the events it wrote after the verification. */
function reject(t, cascade) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL); CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('agent_parent_session:author', 'session-a');
  db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('agent_parent_session:verifier', 'session-b');
  const board = { db };
  const atomic = (_board, work) => work();
  const logEvent = (b, by, kind, itemId, detail) => {
    const result = b.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?,?,?,?,?)').run(new Date().toISOString(), by, kind, itemId, JSON.stringify(detail));
    b.lastEvent = { event_id: Number(result.lastInsertRowid), event_at: new Date().toISOString() };
  };
  const row = parseSpec(`## Verification\n${SOURCE}\n`).rows[0];
  const rowDrafts = () => [{ id: 'F2', by: 'author', target: 'spec', text: row.text, gate: row.gate, tier: row.tier }];
  const receipt = recordRowVerification(board, { agentId: 'verifier', source: SOURCE, decision: 'rejected', reason: 'wording is wrong', cascade },
    { atomic, logEvent, rowDrafts, rowDecisions: () => [] });
  const events = board.db.prepare('SELECT event_kind, event_detail FROM event WHERE event_id >= ? ORDER BY event_id').all(receipt.event)
    .map(event => ({ kind: event.event_kind, detail: JSON.parse(event.event_detail) }));
  return events;
}

test('clause 1: given the cascade rows, rejecting F2 writes one needs-review event each for I1 and I3 naming F2 [C7,#9341]', (t) => {
  const events = reject(t, SPEC_ROWS);
  const marks = events.filter(event => event.kind === 'row_needs_review');
  assert.deepEqual(marks.map(event => event.detail.id), ['I1', 'I3']);
  assert.ok(marks.every(event => event.detail.because === 'F2'), 'each mark names the rejected row');
  assert.deepEqual(events.map(event => event.kind), ['row_verification', 'row_needs_review', 'row_needs_review']);
});

test('clause 2: without the cascade rows (spec.cascadeReject off) a rejection writes exactly the one verification event it wrote before [C7,#9341]', (t) => {
  assert.deepEqual(reject(t, undefined).map(event => event.kind), ['row_verification']);
});
