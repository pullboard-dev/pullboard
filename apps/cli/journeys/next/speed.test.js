/** next selects from a 3,000-item board in seconds, reading eligible items through indexed queries [C7,#3848]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixture,
  cli,
} from '../../tests/fixtures/next/take.js';
import { listItemsSql } from '../../../../packages/store/src/io/board/query.js';

/** File `count` open items no light seat may take, each with a history of events like a long-lived board's. */
function crowd(box, count, events = 12) {
  const { db } = box.board;
  const at = '2026-10-01T00:00:00.000Z';
  const item = db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_route, item_created_by, item_created_at, item_updated_at)
    VALUES ('web', ?, 'The real fixture succeeds.', 'strong', 'coordinator', ?, ?)`);
  const event = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let n = 1; n <= count; n++) {
    const id = Number(item.run(`Crowd item ${n}`, at, at).lastInsertRowid);
    for (let k = 0; k < events; k++) event.run(at, 'coordinator', 'edit', id, '{}');
  }
  db.exec('COMMIT');
}

test('clause 1 and clause 3: a light seat on a 3,000-item board with nothing eligible gets NOTHING_FREE in under 5 s, never NEXT_TIMEOUT [C7,#3848]', async t => {
  const box = await fixture(t, { route: 'light' });
  crowd(box, 3000);
  // The first command settles the proof counters over the filed events, so the timed one measures selection alone.
  const settle = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(settle.document.item, null, settle.out + settle.err);
  const started = performance.now();
  const result = await cli(box, box.seats.actor.path, ['next']);
  const seconds = (performance.now() - started) / 1000;
  assert.equal(result.document.item, null, result.out + result.err);
  assert.doesNotMatch(result.out + result.err, /NEXT_TIMEOUT/u);
  assert.ok(seconds < 5, `selection took ${seconds.toFixed(1)} s`); // budget: declared in the item bar, selection under 5 s.
});

test('clause 2: the item list reads landed flags from one indexed scan of merged events, never an event walk per item [C7,#3848]', async t => {
  const box = await fixture(t);
  crowd(box, 50);
  for (const all of [false, true]) {
    const plan = box.board.db.prepare('EXPLAIN QUERY PLAN ' + listItemsSql({ all, hasLane: false })).all().map(row => row.detail);
    assert.ok(plan.some(line => /SEARCH event USING (?:COVERING )?INDEX event_kind_id \(event_kind=\?\)/u.test(line)), plan.join('\n'));
    assert.ok(!plan.some(line => /event_item_id_event_id/u.test(line)), 'no per-item event walk:\n' + plan.join('\n'));
    assert.ok(!plan.some(line => /^SCAN (?!item\b)/u.test(line)), 'only the item table is scanned:\n' + plan.join('\n'));
  }
});
