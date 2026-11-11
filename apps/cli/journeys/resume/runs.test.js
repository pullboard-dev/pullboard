/** A claim stays alive while a proof run bound to its item is queued or running, and frees again when the run lapses [B4,B28]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/next/take.js';
import { queueTestRun } from '../../../../packages/drive/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { renewLease } from '../../../../packages/jobs/index.js';
import { finishJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import {
  getItem,
  isHeld,
  itemWorkInFlight,
  itemsInStatus,
} from '../../../../packages/store/index.js';

/**
 * Queue a proof run for the seat's item the way `pullboard test` does: bound to the seat's single live claim, else unbound.
 */
function queueRunFor(box, seat) {
  const claims = itemsInStatus(box.board, 'claimed', seat.id);
  const item = claims.length === 1 ? claims[0].item_id : undefined;
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
