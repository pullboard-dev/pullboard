/** @pullboard-test-input source-cell spec */
/** Rejecting a spec row sends each marked row's author one shout, or the coordinator when no author is recorded, only with the cascade on [C7,#9342]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  parseSpec,
  recordRowVerification,
} from '../../index.js';

const SOURCE = '- F2 [approved, must] Fact two holds. | gate: review';
const SPEC_ROWS = [
  { id: 'F2', serves: [] },
  { id: 'I1', serves: ['F2'] },
  { id: 'I3', serves: ['I1'] },
];

/** Reject F2 on a fresh board and return the shouts sent; `drafts` are the board drafts that record each row's author. */
function reject(t, { cascade, drafts }) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL); CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('agent_parent_session:author', 'session-a');
  db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('agent_parent_session:verifier', 'session-b');
  const board = { db };
  const shouts = [];
  const row = parseSpec(`## Verification\n${SOURCE}\n`).rows[0];
  const rowDrafts = () => [{ id: 'F2', by: 'author', target: 'spec', text: row.text, gate: row.gate, tier: row.tier }, ...drafts];
  recordRowVerification(board, { agentId: 'verifier', source: SOURCE, decision: 'rejected', reason: 'wording is wrong', cascade },
    {
      atomic: (_board, work) => work(),
      logEvent: (b, by, kind, itemId, detail) => {
        const result = b.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?,?,?,?,?)').run(new Date().toISOString(), by, kind, itemId, JSON.stringify(detail));
        b.lastEvent = { event_id: Number(result.lastInsertRowid), event_at: new Date().toISOString() };
      },
      rowDrafts,
      rowDecisions: () => [],
      shout: (_board, message) => shouts.push(message),
    });
  return shouts;
}

test('clause 1: after the cascade, each marked row author gets one shout naming the rejected row and the marked row [C7,#9342]', (t) => {
  const shouts = reject(t, { cascade: SPEC_ROWS, drafts: [{ id: 'I1', by: 'writer-one', target: 'spec' }, { id: 'I3', by: 'writer-two', target: 'spec' }] });
  assert.deepEqual(shouts.map(shout => shout.to), ['writer-one', 'writer-two']);
  assert.ok(shouts[0].text.includes('F2') && shouts[0].text.includes('I1'));
  assert.ok(shouts[1].text.includes('F2') && shouts[1].text.includes('I3'));
});

test('clause 2: a marked row with no recorded author goes to the coordinator [C7,#9342]', (t) => {
  const shouts = reject(t, { cascade: SPEC_ROWS, drafts: [{ id: 'I3', by: 'writer-two', target: 'spec' }] });
  assert.deepEqual(shouts.map(shout => shout.to), ['coordinator', 'writer-two']);
});

test('clause 2: nothing is sent with spec.cascadeReject off [C7,#9342]', (t) => {
  assert.deepEqual(reject(t, { cascade: undefined, drafts: [{ id: 'I1', by: 'writer-one', target: 'spec' }] }), []);
});
