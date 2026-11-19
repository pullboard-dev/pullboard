/** With laneMode off, next never hands a seat an open item in a cell another seat's live claim holds [C7,#8907]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchWork } from '../../index.js';
import { fixture } from '../fixtures/dispatch.js';

const LANES = ['web', 'review', 'docs'];

/** Items in two cells: the builder holds one in packages/alpha, a second open item sits in the same cell and a third in packages/beta. */
function cells(t, { beta = true } = {}) {
  const box = fixture(t);
  const held = box.add('Held alpha', { brief: 'Files:\n- packages/alpha/src/a.js\nTest: held.' });
  box.claim(held);
  const sameCell = box.add('Alpha sibling', { brief: 'Files:\n- packages/alpha/tests/b.test.js\nTest: sibling.' });
  const free = beta ? box.add('Beta item', { brief: 'Files:\n- packages/beta/src/c.js\nTest: free.' }) : null;
  const seat = { agent_id: box.seats.actor.id, agent_lane: box.seats.actor.lane };
  return { box, sameCell, free, seat };
}

test('store.io-eligibility.lanes-off-held-cell-skipped: clause 1: with laneMode off an open item in a cell another seat holds is skipped [C7,#8907]', t => {
  const { box, seat } = cells(t, { beta: false });
  assert.equal(dispatchWork(box.board, seat, { lanes: LANES }).item, null);
});

test('store.io-eligibility.lanes-off-free-cell-offered: clause 2: with laneMode off an item in a free cell is still offered [C7,#8907]', t => {
  const { box, free, seat } = cells(t);
  assert.equal(dispatchWork(box.board, seat, { lanes: LANES }).item?.item_id, free);
});

test('store.io-eligibility.lanes-on-unchanged: clause 2: with laneMode on a cell another seat holds does not hide its open items [C7,#8907]', t => {
  const { box, sameCell, seat } = cells(t, { beta: false });
  assert.equal(dispatchWork(box.board, seat).item?.item_id, sameCell);
});
