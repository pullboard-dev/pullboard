import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lifecycleEvent } from '../../src/logic/lifecycle.js';
import { lifecycleMove } from '../../src/logic/lifecycle.js';

/** A renew that carries submitAdmission is a submit holding its lease, so it matches no lifecycle move. */
test('clause 1: a submit lease renewal is not a re-claim [C7]', () => {
  const machine = { moves: [{ verb: 'claim', from: ['claimed'], to: 'claimed' }] };
  const renewal = (detail) => lifecycleEvent({ event_kind: 'renew', event_by: 'a', event_at: '2026-01-01T00:00:00Z', event_detail: JSON.stringify(detail) });
  const lease = { leaseUntil: '2026-01-01T02:00:00Z' };
  assert.equal(lifecycleMove(machine, 'claimed', renewal({ ...lease, submitAdmission: { id: 1 } })), undefined);
  assert.equal(lifecycleMove(machine, 'claimed', renewal(lease))?.verb, 'claim', 'a plain renew still counts as a re-claim');
});
