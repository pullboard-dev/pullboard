/** A recorded companion objection replays through the declared lifecycle, so the projected chart counts it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lifecycleEvent } from '../../index.js';
import { lifecycleSteps } from '../../index.js';
import { MACHINE } from '../../../state/light.js';

/** One board event row as the store records it. */
function row(kind, at, detail = {}) {
  return { event_kind: kind, event_by: 'fixture-agent', event_at: at, event_detail: JSON.stringify(detail) };
}

/** Project the recorded rows the way the view's replay does. */
function steps(rows, status) {
  return lifecycleSteps(MACHINE, rows.map(lifecycleEvent), status);
}

test('items.paths.patch-objection-replay: clause 1: a board with a recorded patch objection replays it, and the projected lifecycle counts one patch-objected [C7]', () => {
  const objected = steps([
    row('add', '2026-11-08T10:00:00.000Z'),
    row('claim', '2026-11-08T10:01:00.000Z', { leaseUntil: '2026-11-08T12:01:00.000Z' }),
    row('submit', '2026-11-08T10:20:00.000Z'),
    row('item_patch_object', '2026-11-08T10:25:00.000Z', { key: 'k', builder: 'b', ownerLane: 'view', note: 'owner objects' }),
  ], 'open');
  assert.equal(objected.filter(step => step.move?.verb === 'patch-objected').length, 1, 'the objection replays as one patch-objected move');
  const last = objected.at(-1);
  assert.deepEqual([last.from, last.move?.to, last.at], ['submitted', 'open', '2026-11-08T10:25:00.000Z'], 'the objection reopens the submitted item at its recorded time');
  // The item starts open, so its add row is the one event with no declared move.
  assert.deepEqual(objected.map(step => step.move?.verb ?? null), [null, 'claim', 'submit', 'patch-objected'], 'claim, submit and the objection each match a declared move');
});

test('items.paths.no-objection-no-move: clause 1: a board without an objection projects no patch-objected move [C7]', () => {
  const plain = steps([
    row('add', '2026-11-08T10:00:00.000Z'),
    row('claim', '2026-11-08T10:01:00.000Z', { leaseUntil: '2026-11-08T12:01:00.000Z' }),
    row('submit', '2026-11-08T10:20:00.000Z'),
  ], 'submitted');
  assert.equal(plain.filter(step => step.move?.verb === 'patch-objected').length, 0);
});
