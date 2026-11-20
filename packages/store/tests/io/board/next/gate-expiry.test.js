/** A deferred or unknown gate stops holding its item once nothing will settle it: next offers the item, and the stale sweep can free the claim [C7,B8]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem } from '../../../../index.js';
import { nextFor } from '../../../../index.js';
import { getItem } from '../../../../index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import { fixture } from '../../../fixtures/dispatch.js';
import { GATE_SETTLE_HOLD_MS } from '../../../../src/io/submit/handoff/records.js';
import { GATE_UNKNOWN_HOLD_MS } from '../../../../src/io/submit/handoff/records.js';
import { gateShardsUnsettled } from '../../../../src/io/submit/handoff/records.js';
import { itemWorkInFlight } from '../../../../src/logic/red/return.js';

const HEAD = 'b'.repeat(40);
const HOUR = 3_600_000;
const DEFERRED_AT = Date.parse('2026-11-20T08:00:00.000Z');

/** A board whose clock reads `DEFERRED_AT + offset`, holding one open web item whose newest gate job finished deferred, not green, with no settled step. */
function deferredBoard(t, offset) {
  const board = fixtureBoard(t, { clock: { now: () => new Date(DEFERRED_AT + offset) } });
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'released while its deferred gate waits' });
  const job = `gate:${id}:${HEAD.slice(0, 12)}:deferred`;
  board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_candidate, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, 'gate', ?, ?, 'done', NULL, 0, ?, ?)`).run(job, id, HEAD, DEFERRED_AT, DEFERRED_AT);
  board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'receipt', ?, ?)")
    .run(job, JSON.stringify({ runner: 'r-1', attempt: 1, receipt: { status: 1, commit: HEAD, gate: { green: false, deferred: true } } }), DEFERRED_AT);
  return { board, id, job };
}

/** Whether next skips the item as GATE_AT_HEAD, or offers it. */
function skipped(board, id) {
  const offered = nextFor(board, { agentId: 'web-2', lane: 'web', observeIdle: true });
  if (offered.item?.item_id === id) return false;
  assert.deepEqual(offered.skips?.find(row => row.item === id), { item: id, code: 'GATE_AT_HEAD' }, offered.reasons.join(' | '));
  return true;
}

test('store.io-board-next-gate-expiry.deferred-gate-expires: clause 1: a deferred unsettled gate with no live shard holds its item at 1 h and not past GATE_SETTLE_HOLD_MS; a live shard keeps the hold, and an edit or refreeze after the job ends it [C7,B8]', t => {
  assert.equal(GATE_SETTLE_HOLD_MS, 2 * HOUR);
  const young = deferredBoard(t, HOUR);
  assert.equal(skipped(young.board, young.id), true, 'at 1 h the deferred gate still holds');
  const old = deferredBoard(t, GATE_SETTLE_HOLD_MS + 1);
  assert.equal(skipped(old.board, old.id), false, 'past 2 h with no live shard, next offers the item');
  const sharded = deferredBoard(t, 3 * HOUR);
  sharded.board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, 'gate-shard', ?, 'claimed', 'r-2', 0, ?, ?)`).run(`${sharded.job}:shard:1`, sharded.id, DEFERRED_AT, DEFERRED_AT);
  assert.equal(skipped(sharded.board, sharded.id), true, 'a claimed shard of the gate keeps the hold past 2 h');
  for (const kind of ['edit', 'refreeze']) {
    const changed = deferredBoard(t, HOUR);
    changed.board.db.prepare("INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,'{}')")
      .run(new Date(DEFERRED_AT + 60_000).toISOString(), 'coordinator', kind, changed.id);
    assert.equal(skipped(changed.board, changed.id), false, `an ${kind} after the gate job ends the hold at 1 h`);
  }
});

/** A claimed item whose gate job, submitted by `submitter` (the holder when omitted), settled with `outcome`; the box clock is then at the settled note. */
function settledGate(t, outcome, submitter) {
  const box = fixture(t);
  const id = box.add('Item whose gate settled');
  box.claim(id);
  const owner = getItem(box.board, id).item_owner;
  const at = box.clock.now().getTime();
  const gate = `gate:${id}:0123456789ab:expiry`;
  const job = (jobId, kind) => box.board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, ?, ?, 'done', NULL, 0, ?, ?)`).run(jobId, kind, id, at, at);
  job(gate, 'gate');
  job(`${gate}:shard:1`, 'gate-shard');
  const step = (name, payload) => box.board.db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, ?, ?, ?)')
    .run(gate, name, JSON.stringify(payload), at);
  step('offered', { request: { submit: { agentId: submitter ?? owner } } });
  step('note:shards.settled', { outcome });
  return { box, item: () => getItem(box.board, id) };
}

test('store.io-board-next-gate-expiry.unknown-hold-bounded: clause 2: an unknown settle holds only its own submitter\'s claim and only for GATE_UNKNOWN_HOLD_MS; a previous holder\'s unknown gate pins nothing, and red or green settles are unchanged, so itemWorkInFlight frees the claim [C7,B8]', t => {
  assert.equal(GATE_UNKNOWN_HOLD_MS, 4 * HOUR);
  const own = settledGate(t, 'unknown');
  own.box.advance(HOUR);
  assert.equal(gateShardsUnsettled(own.box.board, own.item()), true, 'the owner\'s own unknown gate holds at 1 h');
  assert.equal(itemWorkInFlight(own.box.board, own.item()), true);
  own.box.advance(4 * HOUR);
  assert.equal(gateShardsUnsettled(own.box.board, own.item()), false, 'and not at 5 h');
  assert.equal(itemWorkInFlight(own.box.board, own.item()), false, 'so the stale sweep may free the claim');
  const previous = settledGate(t, 'unknown', 'web-previous-holder');
  previous.box.advance(HOUR);
  assert.equal(gateShardsUnsettled(previous.box.board, previous.item()), false, 'a previous holder\'s unknown gate does not pin the new holder\'s claim');
  assert.equal(itemWorkInFlight(previous.box.board, previous.item()), false);
  for (const outcome of ['red', 'green']) {
    const settled = settledGate(t, outcome);
    assert.equal(gateShardsUnsettled(settled.box.board, settled.item()), false, `a ${outcome} settle holds nothing, as before`);
  }
});
