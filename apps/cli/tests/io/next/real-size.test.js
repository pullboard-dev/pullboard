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
