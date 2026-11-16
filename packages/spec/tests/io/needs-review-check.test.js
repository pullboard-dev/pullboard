/** @pullboard-test-input source-cell spec */
/** The spec findings carry a needs-review warning for each row a rejection marked, until it is re-accepted or corrected [C7,#9343]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { needsReviewFindings } from '../../index.js';
import { parseSpec } from '../../index.js';
import { recordRowVerification } from '../../index.js';

const F2 = '- F2 [approved, must] Fact two holds. | gate: review';
const I1 = '- I1 [approved, must] Implication one follows. | serves: F2 | gate: review';
const SPEC = parseSpec(`## Facts\n${F2}\n${I1}\n`);
const CASCADE = SPEC.rows.map(row => ({ id: row.id, serves: row.serves }));

/** A fresh in-memory board with the verification plumbing the verdict code needs, and a helper that records a verdict on one row. */
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL); CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('agent_parent_session:author', 'session-a');
  db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('agent_parent_session:verifier', 'session-b');
  const board = { db };
  const logEvent = (b, by, kind, itemId, detail) => {
    const result = b.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?,?,?,?,?)').run(new Date().toISOString(), by, kind, itemId, JSON.stringify(detail));
    b.lastEvent = { event_id: Number(result.lastInsertRowid), event_at: new Date().toISOString() };
  };
  const verify = (source, decision, cascade) => {
    const row = parseSpec(`## Verification\n${source}\n`).rows[0];
    const rowDrafts = () => [{ id: row.id, by: 'author', target: 'spec', text: row.text, gate: row.gate, tier: row.tier }];
    return recordRowVerification(board, { agentId: 'verifier', source, decision, reason: 'checked', cascade },
      { atomic: (_board, work) => work(), logEvent, rowDrafts, rowDecisions: () => [] });
  };
  return { board, verify, logEvent };
}

test('clause 1: with a needs-review mark on I1, the spec findings include a finding for I1 naming the rejected row F2 [C7,#9343]', (t) => {
  const { board, verify } = fixture(t);
  verify(F2, 'rejected', CASCADE);
  const findings = needsReviewFindings(board, SPEC, { enabled: true });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'I1');
  assert.match(findings[0].message, /rejected F2/u);
  assert.equal(findings[0].line, SPEC.rows.find(row => row.id === 'I1').line);
});

test('clause 2: a later accepted verification of I1 clears its finding [C7,#9343]', (t) => {
  const { board, verify } = fixture(t);
  verify(F2, 'rejected', CASCADE);
  verify(I1, 'accepted');
  assert.deepEqual(needsReviewFindings(board, SPEC, { enabled: true }), []);
});

test('clause 2: a corrected text applied to I1 clears its finding [C7,#9343]', (t) => {
  const { board, verify } = fixture(t);
  verify(F2, 'rejected', CASCADE);
  const mark = board.db.prepare("SELECT event_id FROM event WHERE event_kind='row_needs_review'").get().event_id;
  board.db.prepare("INSERT INTO board_meta VALUES ('row_decisions', ?)").run(JSON.stringify([{ kind: 'spec', id: 'I1', decision: 'approve', event: mark + 1, applied: true }]));
  assert.deepEqual(needsReviewFindings(board, SPEC, { enabled: true }), []);
});

test('clause 2: with spec.cascadeReject off there is no finding even after a marked rejection [C7,#9343]', (t) => {
  const { board, verify } = fixture(t);
  verify(F2, 'rejected', CASCADE);
  assert.deepEqual(needsReviewFindings(board, SPEC, { enabled: false }), []);
  assert.deepEqual(needsReviewFindings(board, SPEC), []);
});
