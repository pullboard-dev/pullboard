/** A reopen or reject after an item's green gate sends it back to work, so next offers it again [C7,#2955]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../../../../jobs/index.js';
import { addItem } from '../../../../index.js';
import { nextFor } from '../../../../index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';

const HEAD = 'a'.repeat(40);

/** Record a green submit job at the item's head the way the submit queue does, finished at the given time. */
function green(board, id, at) {
  board.db.prepare('UPDATE item SET item_commit = ? WHERE item_id = ?').run(HEAD, id);
  recordSubmitHandoff(board.db, id, { id: `fixture-${id}`, commit: HEAD, agentId: 'web-1', state: 'green', at });
}

/** Append one board event of the given kind for the item at the given time. */
function event(board, id, kind, at) {
  board.db.prepare("INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,'{}')").run(at, 'coordinator', kind, id);
}

for (const kind of ['reopen', 'reject']) {
  test(`an item with a ${kind} after its green submit job is offered by next [C7,#2955]`, t => {
    const board = fixtureBoard(t);
    const id = addItem(board, { by: 'coordinator', lane: 'web', title: `${kind}ed after green` });
    green(board, id, '2026-11-04T07:31:47.230Z');
    event(board, id, kind, '2026-11-04T15:46:28.708Z');
    const offered = nextFor(board, { agentId: 'web-2', lane: 'web' });
    assert.equal(offered.item?.item_id, id, offered.reasons.join(' | '));
  });
}

test('store.io-board-next-gate.an-item-whose-green-submit-job: an item whose green submit job is newer than its last reopen is still skipped as gated [C7,#2955]', t => {
  const board = fixtureBoard(t);
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'resubmitted after reopen' });
  event(board, id, 'reopen', '2026-11-04T07:00:00.000Z');
  green(board, id, '2026-11-04T08:00:00.000Z');
  const offered = nextFor(board, { agentId: 'web-2', lane: 'web' });
  assert.equal(offered.item, null);
  assert.ok(offered.reasons.includes(`#${id}: gate green at ${HEAD.slice(0, 12)}; nothing to build`), offered.reasons.join(' | '));
});

test('store.next.derived-gate-at-head-used: nextFor skips an item the derived reader answers a reason for as GATE_AT_HEAD with that reason, without reading its submit hand-off [C7,#10880]', t => {
  const board = fixtureBoard(t);
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'gated by the derived table only' });
  const asked = [];
  const offered = nextFor(board, { agentId: 'web-2', lane: 'web', derivedGateAtHead: entry => { asked.push(entry.item_id); return 'gate green at aaaaaaaaaaaa'; } });
  assert.equal(offered.item, null);
  assert.ok(asked.includes(id), 'the reader was asked about the item');
  assert.ok(offered.reasons.includes(`#${id}: gate green at aaaaaaaaaaaa; nothing to build`), offered.reasons.join(' | '));
  assert.equal(nextFor(board, { agentId: 'web-2', lane: 'web' }).item?.item_id, id, 'with no submit hand-off recorded, only the derived answer skipped it');
});

test('store.next.derived-gate-at-head-fallback: nextFor computes an item the reader answers undefined for, and every item when the option is absent, with gateAtHead as before [C7,#10880]', t => {
  const board = fixtureBoard(t);
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'gate queued after the reader was built' });
  green(board, id, '2026-11-04T08:00:00.000Z');
  const gated = `#${id}: gate green at ${HEAD.slice(0, 12)}; nothing to build`;
  for (const options of [{ derivedGateAtHead: () => undefined }, {}]) {
    const offered = nextFor(board, { agentId: 'web-2', lane: 'web', ...options });
    assert.equal(offered.item, null);
    assert.ok(offered.reasons.includes(gated), offered.reasons.join(' | '));
  }
});

/** Record a done gate job for the item whose posted receipt deferred its proof and is not green, finished at `at` (ms), as a pulled gate leaves it before its shards settle. */
function deferredGate(board, id, at) {
  const job = `gate:${id}:${HEAD.slice(0, 12)}:deferred`;
  board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_candidate, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, 'gate', ?, ?, 'done', NULL, 0, ?, ?)`).run(job, id, HEAD, at, at);
  board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'receipt', ?, ?)")
    .run(job, JSON.stringify({ runner: 'r-1', attempt: 1, receipt: { status: 1, commit: HEAD, gate: { green: false, deferred: true, deferNote: 'full suite deferred to the landing gate' } } }), at);
  return job;
}

const DEFERRED_AT = Date.parse('2026-11-19T20:00:00.000Z');

test('store.io-board-next-gate.deferred-unsettled-gate-skipped: clause 1: nextFor skips an open item whose newest gate job finished deferred, not green, with no settled shards, as GATE_AT_HEAD naming the deferred gate [C7]', t => {
  const board = fixtureBoard(t);
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'released while its deferred gate waits' });
  deferredGate(board, id, DEFERRED_AT);
  const offered = nextFor(board, { agentId: 'web-2', lane: 'web', observeIdle: true });
  assert.equal(offered.item, null, offered.reasons.join(' | '));
  assert.deepEqual(offered.skips?.find(row => row.item === id), { item: id, code: 'GATE_AT_HEAD' }, JSON.stringify(offered.skips));
  assert.ok(offered.reasons.includes(`#${id}: gate deferred at ${HEAD.slice(0, 12)}, its proof unsettled; nothing to build`), offered.reasons.join(' | '));
});

test('store.io-board-next-gate.deferred-settled-gate-offered: clause 2: the same item is offered again once its gate job has a note:shards.settled step, and when a reopen follows the gate job [C7]', t => {
  const board = fixtureBoard(t);
  const settled = addItem(board, { by: 'coordinator', lane: 'web', title: 'deferred gate settled' });
  const job = deferredGate(board, settled, DEFERRED_AT);
  board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'note:shards.settled', ?, ?)").run(job, JSON.stringify({ outcome: 'stale' }), DEFERRED_AT + 1);
  assert.equal(nextFor(board, { agentId: 'web-2', lane: 'web' }).item?.item_id, settled, 'a settled deferred gate holds nothing');
  const reopened = fixtureBoard(t);
  const id = addItem(reopened, { by: 'coordinator', lane: 'web', title: 'deferred gate reopened' });
  deferredGate(reopened, id, DEFERRED_AT);
  event(reopened, id, 'reopen', '2026-11-19T21:00:00.000Z');
  assert.equal(nextFor(reopened, { agentId: 'web-2', lane: 'web' }).item?.item_id, id, 'a reopen after the gate job sends it back for work');
});
