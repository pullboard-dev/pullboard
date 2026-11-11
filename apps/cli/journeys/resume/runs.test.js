/** A claim stays alive while a proof run bound to its item is queued or running, and frees again when the run lapses [B4,B28]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/next/take.js';
import { queueTestRun } from '../../../../packages/drive/index.js';
import { workTestRun } from '../../../../packages/drive/index.js';
import { captureLapsedClaims } from '../../../../packages/health/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { renewLease } from '../../../../packages/jobs/index.js';
import { finishJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import {
  getItem,
  heartbeatSeat,
  isHeld,
  itemWorkInFlight,
  itemsInStatus,
  seatGone,
} from '../../../../packages/store/index.js';

/**
 * Queue a proof run for the seat's item the way `pullboard test` does: bound to the seat's single live claim, else unbound.
 */
function queueRunFor(box, seat, bound) {
  const claims = itemsInStatus(box.board, 'claimed', seat.id);
  const item = bound ?? (claims.length === 1 ? claims[0].item_id : undefined);
  const queued = queueTestRun({ info: { root: box.root, commonDir: box.root } }, work => work(box.board),
    { agent: seat.id, item, files: ['a.test.js'] }, { launch: () => ({ unref() {} }), now: box.clock.now().getTime() });
  return { ...queued, item };
}

test('clause 1: a claim keeps through the sweep while its proof run has a live lease, and frees once the run lapses [B4,B28]', async t => {
  const box = await fixture(t);
  const seat = box.seats.actor;
  const id = box.add('Held by a proof run');
  box.claim(id, seat);
  const run = queueRunFor(box, seat);
  assert.equal(run.item, id, 'the run binds to the seat\'s single live claim');
  const item = () => getItem(box.board, id);
  box.advance(3 * 3_600_000);
  assert.equal(itemWorkInFlight(box.board, item()), false, 'a run no worker took within its start bound is not work in flight');
  assert.equal(isHeld(box.board, item()), false);
  assert.equal(takeJob(box.board.db, run.id, 'test-run:1', { now: box.clock.now().getTime(), leaseMs: 120_000 }).taken, true);
  writeStep(box.board.db, run.id, 'running', {}, { now: box.clock.now().getTime() });
  assert.equal(itemWorkInFlight(box.board, item()), true, 'a running run with a live job lease keeps the claim');
  assert.equal(isHeld(box.board, item()), true);
  box.advance(60_000);
  assert.equal(renewLease(box.board.db, run.id, 'test-run:1', { now: box.clock.now().getTime(), leaseMs: 120_000 }), true);
  box.advance(100_000);
  assert.equal(itemWorkInFlight(box.board, item()), true, 'a renewed lease still holds');
  box.advance(121_000);
  assert.equal(itemWorkInFlight(box.board, item()), false, 'a worker that stopped renewing frees the claim for the sweep');
  assert.equal(isHeld(box.board, item()), false);
});

test('clause 2: a finished run ends the hold, a run holds only its own item, and a freshly queued run holds [B4,B28]', async t => {
  const box = await fixture(t);
  const seat = box.seats.actor;
  const id = box.add('Held by a proof run');
  const other = box.add('Another item', { brief: 'Files: web/other.js\nTest: an unrelated file.' });
  box.claim(id, seat);
  const run = queueRunFor(box, seat);
  assert.equal(itemWorkInFlight(box.board, getItem(box.board, id)), true, 'a run queued a moment ago holds before a worker takes it');
  takeJob(box.board.db, run.id, 'test-run:2', { now: box.clock.now().getTime(), leaseMs: 120_000 });
  assert.equal(itemWorkInFlight(box.board, getItem(box.board, other)), false, 'a run bound to one item holds only that item');
  writeStep(box.board.db, run.id, 'result', { green: true }, { now: box.clock.now().getTime() });
  finishJob(box.board.db, run.id, 'test-run:2');
  assert.equal(itemWorkInFlight(box.board, getItem(box.board, id)), false, 'a recorded result ends the hold');
});

test('clause 1: the stale sweep keeps a quiet seat\'s claim while its proof run is live and frees it once the run lapses [B4,B28]', async t => {
  const box = await fixture(t);
  const seat = box.seats.actor;
  const id = box.add('Held through the sweep');
  const control = box.add('Control with no run', { brief: 'Files: web/control.js\nTest: a quiet seat without a run is swept.' });
  box.claim(id, seat);
  box.claim(control, box.seats.builder);
  // Live holders keep the sweep from reading two quiet claims as the whole machine stalling.
  const holders = [box.seats.sibling, box.seats.sameFamily, box.seats.outside];
  for (const [n, holder] of holders.entries()) box.claim(box.add(`Live claim ${n}`, { lane: 'review', brief: `Files: web/live${n}.js\nTest: a live seat is never swept.` }), holder);
  const ctx = { clock: box.clock, config: box.config, info: { root: box.root } };
  const sweep = () => {
    for (const holder of holders) heartbeatSeat(box.board, holder.id);
    const snapshot = captureLapsedClaims(ctx, box.board, 'coordinator');
    return snapshot ? snapshot.claims.map(claim => claim.id) : [];
  };
  box.advance(3 * 60_000);
  const run = queueRunFor(box, seat, id);
  assert.deepEqual(sweep(), [control], 'both seats are quiet over 2 minutes: only the claim with no run is swept');
  takeJob(box.board.db, run.id, 'test-run:sweep', { now: box.clock.now().getTime(), leaseMs: 120_000 });
  writeStep(box.board.db, run.id, 'running', {}, { now: box.clock.now().getTime() });
  box.advance(60_000);
  assert.equal(renewLease(box.board.db, run.id, 'test-run:sweep', { now: box.clock.now().getTime(), leaseMs: 120_000 }), true);
  assert.equal(sweep().includes(id), false, 'a running proof run with a live lease keeps the quiet seat\'s claim');
  box.advance(121_000);
  assert.equal(sweep().includes(id), true, 'once the worker stops renewing, the sweep frees the claim');
});

test('clause 2: a running test-run worker beats its agent seat while it renews the job lease [B4,B28]', async t => {
  const box = await fixture(t);
  const seat = box.seats.actor;
  const id = box.add('Beaten by a worker');
  box.claim(id, seat);
  const run = queueRunFor(box, seat);
  box.advance(5 * 60_000);
  assert.equal(seatGone(box.board, seat.id), true, 'the seat is quiet before the worker starts');
  let beats = 0;
  let enough;
  const renewed = new Promise(done => { enough = done; });
  await workTestRun(work => work(box.board), run.id, async () => { await renewed; return { green: true, files: ['a.test.js'] }; },
    { renewMs: 5, beatSeat: board => { beats += 1; heartbeatSeat(board, seat.id); if (beats >= 2) enough(); } });
  assert.ok(beats >= 2, 'the worker beat at start and on each lease renewal');
  assert.equal(seatGone(box.board, seat.id), false, 'the beats keep the seat from reading gone');
});
