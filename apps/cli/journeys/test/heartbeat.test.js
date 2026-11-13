/** A claim stays live while its pullboard test runs, so the stale sweep never removes the item folder mid-run [C7,#3430]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/src/logic/native.js';
import { captureLapsedClaims } from '../../../../packages/health/index.js';
import { itemFolderPath } from '../../index.js';
import { whileSeatAlive } from '../../../../packages/gate/src/io/keepalive.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

/** A clock the test moves by hand, so minutes pass without waiting for them. */
function manualClock(start = Date.parse('2026-11-01T12:00:00.000Z')) {
  let now = start;
  return { now: () => new Date(now), advance: ms => { now += ms; } };
}

/** An injected scheduler: the test fires the registered tick itself, so no real timer is waited on. */
function scheduler() {
  const timers = [];
  return { timers,
    every: (tick, ms) => { const timer = { tick, ms, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; } };
}

/** A real seat checkout, an item folder shaped like a linked worktree, and a SQLite board holding the seat's claim. */
function fixture(t) {
  const files = privateFixtureFiles('pullboard-test-run-heartbeat-');
  const seatRoot = join(files.root, 'seat');
  mkdirSync(seatRoot);
  const clock = manualClock();
  const board = openBoard(':memory:', clock);
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: join(files.root, 'main') });
  const seat = store.register(board, { lane: 'core', path: seatRoot, route: 'mid' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'long test', criterion: 'prove', specIds: ['C7'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' });
  store.claim(board, id, { agentId: seat, lane: 'core', leaseMs: 7_200_000, freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'digest:bar' }) });
  const folder = itemFolderPath(seatRoot, id);
  // The item folder is a linked worktree as far as seat lookup goes: a .git file naming a git dir that keeps the item marker.
  const gitDir = join(seatRoot, '.git-worktrees', `item-${id}`);
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(join(seatRoot, '.git-common', 'pullboard'), { recursive: true });
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.git'), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, 'commondir'), `${join(seatRoot, '.git-common')}\n`);
  writeFileSync(join(gitDir, 'pullboard-item.json'), JSON.stringify({ version: 1, seat, item: id }) + '\n');
  /** The seat-gone claims the stale sweep would reclaim at the clock's present moment. */
  const gone = () => (captureLapsedClaims({ clock, config: {} }, board, 'coordinator')?.claims ?? []).filter(row => row.idle === 'seat-gone');
  return { board, clock, seat, id, folder, gone };
}

test('clause 1: a pullboard test waiting on a runner past two minutes keeps the claim live [C7]', async t => {
  const f = fixture(t), timers = scheduler();
  let ticks;
  await whileSeatAlive(f.folder, async () => {
    assert.equal(timers.timers.length, 1, 'a run started from the item folder registers one beat');
    assert.ok(timers.timers[0].ms <= 60_000, 'the beat is well inside the two-minute seat-gone limit');
    // Six simulated minutes of waiting on a runner, one beat every 30 s.
    for (ticks = 0; ticks < 12; ticks += 1) { f.clock.advance(30_000); timers.timers[0].tick(); }
    assert.deepEqual(f.gone(), [], 'the sweep takes no claim from a seat whose test is still running');
  }, { ...timers, everyMs: 30_000, beat: (file, seat) => store.heartbeatSeat(f.board, seat) });
  assert.equal(timers.timers[0].cancelled, true, 'the beat stops when the run ends');
});

test('clause 2: a test whose process died lets the sweep reclaim [C7]', async t => {
  const f = fixture(t), timers = scheduler();
  await whileSeatAlive(f.folder, async () => { f.clock.advance(30_000); timers.timers[0].tick(); },
    { ...timers, everyMs: 30_000, beat: (file, seat) => store.heartbeatSeat(f.board, seat) });
  assert.equal(timers.timers[0].cancelled, true);
  f.clock.advance(2 * 60_000 + 1_000);
  assert.deepEqual(f.gone().map(row => row.actor), [f.seat], 'with no beat for two minutes the sweep reclaims the claim as today');
});
