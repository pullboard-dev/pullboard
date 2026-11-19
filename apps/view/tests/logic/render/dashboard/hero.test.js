/** The server's last-four-hour counts, which stand in for the Dashboard's while its history loads [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { dashboardRecent } from '../../../../src/io/dashboard/recent.js';

const now = Date.parse('2026-11-12T18:00:00Z');
const minutes = n => new Date(now - n * 60_000).toISOString();

test('view.x-render-dashboard-hero.the-server-counts-the-last-four-hours: the server counts the last four hours from real SQLite events, stopping at the window edge [N26]', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}'); CREATE INDEX event_kind_id ON event (event_kind, event_id)");
  const add = (at, kind, item, detail = {}) => db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)').run(at, 'core-1', kind, item, JSON.stringify(detail));
  add(minutes(300), 'merged', 1, { commit: 'a' }); // item 1 first landed before the window
  add(minutes(300), 'accept', 9);
  add(minutes(300), 'reject', 9);
  add(minutes(200), 'merged', 1, { commit: 'a' }); // a redelivery of item 1's landing is not a new landing
  add(minutes(100), 'merged', 2, { commit: 'b' });
  add(minutes(90), 'merged', 3, { commit: 'old' }); // not item 3's current merge
  add(minutes(60), 'accept', 2);
  add(minutes(50), 'reject', 4);
  add(minutes(40), 'reopen', 5);
  add(minutes(30), 'shout', null, { to: 'person' });
  add(minutes(20), 'shout', null, { to: 'coordinator' });
  add(new Date(now + 60_000).toISOString(), 'accept', 6); // after the snapshot clock
  const items = new Map([[1, { item_merged_commit: 'a' }], [2, { item_merged_commit: 'b' }], [3, { item_merged_commit: 'new' }]]);
  const counts = dashboardRecent({ db }, items, now);
  assert.deepEqual(counts, { landed: 1, passed: 1, accepted: 1, sentBack: 2, shouts: 1, since: now - 4 * 3_600_000, until: now });
  assert.deepEqual(dashboardRecent({ db }, items, now + 10 * 3_600_000).landed, 0, 'an empty window counts 0');
});
