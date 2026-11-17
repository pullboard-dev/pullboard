/** The shadow claim records project the diagnosed value the board computes, brief-form diagnosis included (#3193) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readClaimRecords } from '../../../index.js';

const GOOD = 'Files: web/handler.js\nChange: repoint the handler\nTest: the handler case returns the result';
const BAD = 'Files: web/handler.js\nTest: the handler case';

/** An in-memory board with two light items, one with a diagnosis-form brief and one without, each claimed by a light seat. */
function board() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agent (agent_id TEXT, agent_lane TEXT, agent_route TEXT);
    CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_parent_id INTEGER, item_brief TEXT);
    CREATE TABLE board_meta (meta_key TEXT, meta_value TEXT)`);
  db.prepare('INSERT INTO agent VALUES (?, ?, ?)').run('core-1', 'core', 'light');
  db.prepare('INSERT INTO item VALUES (?, NULL, ?)').run(1, GOOD);
  db.prepare('INSERT INTO item VALUES (?, NULL, ?)').run(2, BAD);
  const add = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  for (const id of [1, 2]) add.run('2026-11-01T00:00:00.000Z', 'coordinator', 'add', id, '{"lane":"core","route":"light"}');
  for (const id of [1, 2]) add.run('2026-11-02T00:00:00.000Z', 'core-1', 'claim', id, JSON.stringify({ leaseUntil: '2026-11-02T02:00:00.000Z', digest: 'bar' }));
  return { db };
}

test('moves.claim-records-brief.the-shadow-claim-records-project-diagnosed-true: clause 3: the shadow claim records project diagnosed true for a parsing brief and false for one that does not [C7]', () => {
  const { records } = readClaimRecords(board(), { since: '2026-11-01T00:00:00.000Z' });
  assert.deepEqual(records.map(record => [record.move.id, record.snapshot.item.diagnosed]), [[1, true], [2, false]]);
});
