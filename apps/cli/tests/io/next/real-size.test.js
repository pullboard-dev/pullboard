/** Real Git, SQLite and the command parser on a production-size board [N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { REAL_SIZE } from '../../fixtures/next/real-size.js';
import { seedRealSize } from '../../fixtures/next/real-size.js';

/** Seed the real-size board and run one `next --take` with the phase profile on. */
async function takeOnRealSizeBoard(t) {
  const box = await fixture(t, { route: 'light' });
  seedRealSize(box);
  // The seat's lane and route need one open item filed the ordinary way, so the take on the big board hands out real work.
  box.add('Real-size handout', { route: 'light' });
  const before = process.env.PULLBOARD_NEXT_PROFILE;
  process.env.PULLBOARD_NEXT_PROFILE = '1';
  try {
    const started = performance.now();
    const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
    return { taken, seconds: (performance.now() - started) / 1000 };
  } finally {
    if (before === undefined) delete process.env.PULLBOARD_NEXT_PROFILE; else process.env.PULLBOARD_NEXT_PROFILE = before;
  }
}

test('cli.io-next-real-size.cli-next-real-size-a-seeded-board: cli.next.real-size.a-seeded-board-of-230-000: clause 1: a seeded board of 230,000 events and 1,800 agents has mid-route open items for next to hand out [N2]', async t => {
  const box = await fixture(t, { route: 'light' });
  const seeded = seedRealSize(box);
  assert.deepEqual(seeded, { events: REAL_SIZE.events, agents: REAL_SIZE.agents, buildItems: REAL_SIZE.buildItems, reviewItems: REAL_SIZE.reviewItems });
  assert.ok(seeded.events >= 230_000 && seeded.agents >= 1_800);
  const { db } = box.board;
  const mid = db.prepare("SELECT COUNT(*) AS n FROM item WHERE item_title LIKE 'Real build %' AND item_route = 'mid' AND item_status = 'open'").get().n;
  assert.ok(mid > 0, 'the seed files mid-route open build items');
});

test('cli.io-next-real-size.cli-next-real-size-next-take-on: cli.next.real-size.next-take-on-that-board-prints: clause 2: next --take on that board prints a per-read-path wall time and finishes under 2 s [N2]', async t => {
  const { taken, seconds } = await takeOnRealSizeBoard(t);
  assert.equal(taken.code, 0, taken.out + taken.err);
  const profile = taken.err.split('\n').filter(line => line.startsWith('next profile: '));
  assert.ok(profile.some(line => line.includes(' ms; slowest three: ')), 'the profile names the slowest read paths: ' + taken.err);
  console.log(`next --take on ${REAL_SIZE.events} events, ${REAL_SIZE.agents} agents: ${seconds.toFixed(2)} s wall\n${profile.join('\n')}`);
  // The budget is the wall time around the whole command, as the original journey asserted; the profile's own total excludes process start.
  assert.ok(seconds < 2, `next --take took ${seconds.toFixed(2)} s wall on the real-size board:\n${profile.join('\n')}`);
});

test('cli.io-next-real-size.seed-rows-deterministic: clause 1: after seedRealSize, event row n has agent real-(n mod 1800), kind edit, detail {} and the (n mod 600)th seeded item [N2]', async t => {
  const box = await fixture(t, { route: 'light' });
  seedRealSize(box);
  const { db } = box.board;
  const items = db.prepare("SELECT item_id FROM item WHERE item_title LIKE 'Real %' ORDER BY item_id").all().map(row => row.item_id);
  assert.equal(items.length, 600);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM event').get().n, 230_000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent WHERE agent_id LIKE 'real-%'").get().n, 1_800);
  // The fixture's own setup events come first; the seeded rows are the ones that follow, numbered from 0.
  const rows = db.prepare("SELECT event_by, event_kind, event_detail, item_id FROM event WHERE event_by LIKE 'real-%' ORDER BY event_id").all();
  assert.ok(rows.length > 229_900 && rows.length < 230_000);
  for (const n of [0, 1, 599, 600, 1_799, 1_800, 123_456, rows.length - 1]) {
    assert.deepEqual({ ...rows[n] }, { event_by: `real-${n % 1800}`, event_kind: 'edit', event_detail: '{}', item_id: items[n % 600] }, `event row ${n}`);
  }
  assert.ok(rows.every((row, n) => row.event_by === `real-${n % 1800}` && row.item_id === items[n % 600]), 'every row follows the pattern');
});
