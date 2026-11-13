/** The Dashboard hero's four-hour chips are numbers, never dashes; an unread count says why on hover [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { dashboardHtml } from '../../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../../src/io/dashboard/model.js';
import { dashboardRecent } from '../../../../src/io/dashboard/recent.js';

const now = Date.parse('2026-11-12T18:00:00Z');
const minutes = n => new Date(now - n * 60_000).toISOString();

/** The four hero chips, by key, as rendered. */
function chips(html) {
  const hero = html.slice(html.indexOf('dash-hero'), html.indexOf('</section>', html.indexOf('dash-hero')));
  return Object.fromEntries([...hero.matchAll(/<span( class="dash-unread")? title="([^"]*)" data-dashboard-recent="(\w+)" data-value="(\d*)">(.*?)<\/span>/gu)]
    .map(([, unread, title, key, value, body]) => [key, { unread: Boolean(unread), title, value, text: body.replace(/<[^>]+>/gu, '') }]));
}

test('clause 1: the hero chips show landed, passed review, sent back and shouts to you as numbers, 0 when none [N26]', () => {
  const project = { items: [], agents: [], sequence: 50, dashboardRecent: { landed: 3, passed: 0, sentBack: 2, shouts: 0, since: now - 4 * 3_600_000, until: now } };
  // The browser's history is incomplete, as on a long board: the server's own counts still show.
  const model = dashboardModel(project, [], { now, complete: false });
  assert.deepEqual([model.totals.recent, model.totals.passed, model.totals.sentBack, model.totals.shouts], [3, 0, 2, 0]);
  const shown = chips(dashboardHtml(model));
  assert.deepEqual(Object.keys(shown), ['recent', 'passed', 'sentBack', 'shouts']);
  assert.deepEqual(Object.values(shown).map(chip => chip.text), ['3 landed', '0 passed review', '2 sent back to fix', '0 shouts to you']);
  assert.ok(Object.values(shown).every(chip => !chip.unread && !chip.text.includes('—')), 'no chip is a dash');

  // With nothing at all in the window, every chip reads 0.
  const empty = dashboardModel({ items: [], agents: [], sequence: 0 }, [], { now, complete: true });
  assert.deepEqual(Object.values(chips(dashboardHtml(empty))).map(chip => chip.value), ['0', '0', '0', '0']);
});

test('clause 2: a count the board cannot read says why on hover instead of a dash [N26]', () => {
  const model = dashboardModel({ items: [], agents: [], sequence: 50 }, [], { now, complete: false });
  assert.match(model.unread, /still loading/u);
  const shown = chips(dashboardHtml(model));
  assert.equal(Object.keys(shown).length, 4);
  for (const [key, chip] of Object.entries(shown)) {
    assert.ok(chip.unread, key + ' is marked unread');
    assert.ok(!chip.text.includes('—'), key + ' shows no dash');
    assert.match(chip.title, /in the last 4 hours is not read yet: The board has not sent its last-4-hour counts yet, and its full event history is still loading\./u, key + ' says why on hover');
  }
});

test('the server counts the last four hours from real SQLite events, stopping at the window edge [N26]', () => {
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
  assert.deepEqual(counts, { landed: 1, passed: 1, sentBack: 2, shouts: 1, since: now - 4 * 3_600_000, until: now });
  assert.deepEqual(dashboardRecent({ db }, items, now + 10 * 3_600_000).landed, 0, 'an empty window counts 0');
});
