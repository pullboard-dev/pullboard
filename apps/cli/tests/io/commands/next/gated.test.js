/** next hands a seat new work while its submitted claim's sharded gate settles, and keeps that claim held for the result [C7,#10959]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { recordSubmitHandoff } from '../../../../../../packages/jobs/index.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';
import { heartbeatSeat } from '../../../../../../packages/store/index.js';

/** Put one gate or shard job row on the board as the jobs cell writes it. */
function job(board, { id, kind, item, step, at }) {
  board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`).run(id, kind, item, step, at, at);
}

/**
 * At claims.perSeat 1 the actor seat holds one item whose pulled gate job is done and left its proof to shards, the
 * state a submitted claim sits in while its sharded gate runs; a second, disjoint item is open.
 */
async function gatedSeat(t, shardSteps = ['done', 'offered', 'claimed']) {
  const box = await fixture(t, { perSeat: 1 });
  const seat = box.seats.actor;
  const gated = box.add('Submitted work in its sharded gate', { brief: 'Files: web/gated.js\nTest: the real board selects the item.' });
  const fresh = box.add('Fresh work for the same seat', { brief: 'Files: web/fresh.js\nTest: the real board selects the item.' });
  box.claim(gated, seat);
  const at = box.clock.now().getTime();
  const gate = `gate:${gated}:fixture`;
  job(box.board, { id: gate, kind: 'gate', item: gated, step: 'done', at });
  shardSteps.forEach((step, index) => job(box.board, { id: `${gate}:shard:${index + 1}`, kind: 'gate-shard', item: gated, step, at: at + 1 + index }));
  return { box, seat, gated, fresh, gate };
}

test('cli.journeys-next-gated-claim.gated-claim-gets-new-work: clause 1: production wiring: at claims.perSeat 1, a seat whose one claim has a done gate job with proof shards still offered runs the real pullboard next and it claims a new open item, not "you hold" the gated one [C7,#10959]', async t => {
  const { box, seat, gated, fresh } = await gatedSeat(t);
  const taken = await cli(box, seat.path, ['next']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document?.item?.item_id, fresh, `next answered with #${taken.document?.item?.item_id}; the gated claim #${gated} is not work the seat holds`);
  assert.equal(taken.document.held, false, 'the new item is claimed, not held');
  const item = store.getItem(box.board, fresh);
  assert.equal(item.item_status, 'claimed');
  assert.equal(item.item_owner, seat.id);
});

test('cli.journeys-next-gated-claim.gated-claim-stays-held: clause 2: after that next the gated item is still claimed by the same seat with its lease, so the hold for the gate result is kept [C7,#10931,#10934,#10959]', async t => {
  const { box, seat, gated } = await gatedSeat(t, Array(4).fill('done'));
  const before = store.getItem(box.board, gated);
  const taken = await cli(box, seat.path, ['next']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.notEqual(taken.document?.item?.item_id, gated, 'all shards done but unsettled: still the gate\'s wait, not buildable work');
  const after = store.getItem(box.board, gated);
  assert.equal(after.item_status, 'claimed', 'the gated claim is not released');
  assert.equal(after.item_owner, seat.id, 'the submitting seat still holds it, so the gate result applies');
  assert.equal(after.item_lease_until, before.item_lease_until, 'its lease is untouched');
});

test('cli.journeys-next-gated-claim.settled-red-comes-first: clause 3: once that gate settles and its red is returned to the seat, next hands the seat that claim first and names the returned red [C7,#10959]', async t => {
  const { box, seat, gated, fresh, gate } = await gatedSeat(t, Array(3).fill('done'));
  const at = box.clock.now().getTime() + 10;
  box.board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'note:shards.settled', '{\"outcome\":\"red\"}', ?)").run(gate, at);
  const head = box.git(seat.path, 'rev-parse', 'HEAD');
  recordSubmitHandoff(box.board.db, gated, { version: 1, id: `${gate}:red`, agentId: seat.id, main: head, commit: head, tree: 't'.repeat(40), executionTree: 't'.repeat(40),
    digest: store.getItem(box.board, gated).item_frozen_digest, state: 'red', gateGreen: false, error: { code: 'GATE_RED', message: 'shard 2 failed' } }, { now: at + 1 });
  const taken = await cli(box, seat.path, ['next']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document?.item?.item_id, gated, `next answered with #${taken.document?.item?.item_id}; the returned red comes first`);
  assert.equal(taken.document.returned?.gate?.code, 'GATE_RED', 'next names the returned red');
  assert.notEqual(store.getItem(box.board, fresh).item_owner, seat.id, 'no new claim is taken over the red');
});

test('cli.journeys-next-gated-claim.lapsed-gated-claim-not-handed: clause 3: production wiring: another seat holds an item with a lapsed lease whose gate job was created 2 h 10 min ago and offered its open shards 1 h 20 min ago; at claims.perSeat 1 a fresh seat runs the real pullboard next and claims the open item, and the gated item stays with its holder [C7,#11921]', async t => {
  const box = await fixture(t, { perSeat: 1 });
  const holder = box.seats.builder;
  const seat = box.seats.actor;
  const gated = box.add('Submitted work whose gate queued before its checks', { brief: 'Files: web/gated.js\nTest: the real board selects the item.' });
  const fresh = box.add('Fresh work for a fresh seat', { brief: 'Files: web/fresh.js\nTest: the real board selects the item.' });
  box.claim(gated, holder);
  const created = box.clock.now().getTime();
  const offered = created + 50 * 60_000;
  const gate = `gate:${gated}:late`;
  box.board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, 'gate', ?, 'done', NULL, 0, ?, ?)`).run(gate, gated, created, offered);
  ['offered', 'claimed'].forEach((step, index) => job(box.board, { id: `${gate}:shard:${index + 1}`, kind: 'gate-shard', item: gated, step, at: offered + index }));
  box.advance(130 * 60_000);
  heartbeatSeat(box.board, seat.id);
  assert.ok(Date.parse(store.getItem(box.board, gated).item_lease_until) < box.clock.now().getTime(), 'the holder\'s lease has lapsed');
  const taken = await cli(box, seat.path, ['next']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document?.item?.item_id, fresh, `next answered with #${taken.document?.item?.item_id}; the lapsed claim #${gated} is waiting on its shards`);
  assert.equal(taken.document.held, false, 'the new item is claimed, not held');
  const after = store.getItem(box.board, gated);
  assert.equal(after.item_status, 'claimed', 'the gated claim is not released');
  assert.equal(after.item_owner, holder.id, 'its holder keeps it, so the gate result applies');
});
