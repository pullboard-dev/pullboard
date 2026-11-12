import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../tests/fixtures/next/take.js';
import { REAL_SIZE } from '../../tests/fixtures/next/real-size.js';
import { seedRealSize } from '../../tests/fixtures/next/real-size.js';

/** Count rows and a content digest the seed fixes. */
function shape(box) {
  const one = sql => box.board.db.prepare(sql).get();
  return {
    // Fixture seats and filed events exist before the seed, so count only the seeded rows.
    events: one("SELECT COUNT(*) AS n FROM event WHERE event_by LIKE 'real-%'").n,
    agents: one("SELECT COUNT(*) AS n FROM agent WHERE agent_id LIKE 'real-%'").n,
    build: one("SELECT COUNT(*) AS n FROM item WHERE item_title LIKE 'Real build %' AND item_status = 'open'").n,
    review: one("SELECT COUNT(*) AS n FROM item WHERE item_title LIKE 'Real review %' AND item_status = 'open' AND item_lane = 'review'").n,
    digest: one("SELECT group_concat(item_title || item_route || item_lane, '|') AS d FROM (SELECT * FROM item WHERE item_title LIKE 'Real %' ORDER BY item_title)").d,
    byAgent: one("SELECT group_concat(c, ',') AS d FROM (SELECT COUNT(*) AS c FROM event WHERE event_by LIKE 'real-%' GROUP BY event_by ORDER BY event_by)").d,
  };
}

test('clause 1: the real-size seeder fills 230,000 events, 1,800 agents and open build and review items in under 60 s [N2]', async t => {
  const box = await fixture(t);
  const started = performance.now();
  seedRealSize(box);
  const seconds = (performance.now() - started) / 1000;
  assert.ok(seconds < 60, `seeding took ${seconds.toFixed(1)} s`); // budget: declared in the item bar, under 60 s.
  const rows = shape(box);
  assert.ok(rows.build > 0 && rows.review > 0);
});

test('clause 2: the seeded rows match the stated counts and the same seed gives the same board twice [N2]', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  seedRealSize(first); seedRealSize(second);
  const a = shape(first);
  assert.equal(a.events, REAL_SIZE.events);
  assert.equal(a.agents, REAL_SIZE.agents);
  assert.equal(a.build, REAL_SIZE.buildItems);
  assert.equal(a.review, REAL_SIZE.reviewItems);
  assert.deepEqual(shape(second), a);
});
