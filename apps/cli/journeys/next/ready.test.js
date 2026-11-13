/** next never hands out an item that claim refuses as BAR_NOT_READY [N2,B4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { addMilestone } from '../../../../packages/store/index.js';
import { setBarReady } from '../../../../packages/verify/index.js';
import { FREEZE } from '../../tests/fixtures/next/order.js';
import { HOUR } from '../../tests/fixtures/next/order.js';
import { lineOrderFixture } from '../../tests/fixtures/next/order.js';

// fixture-subject: addItem (next ordering over items the fixture seeds in process, with bar readiness switched on)
test('clause 1: next hands the item claim accepts, not the ranked one claim would refuse BAR_NOT_READY [N2,B4]', t => {
  const { board, builder, order } = lineOrderFixture(t);
  const fields = { by: 'coordinator', lane: 'core', criterion: 'a real condition is observable', check: 'true', brief: 'Files: src/ready.js\nTest: the condition is checked' };
  const unready = store.addItem(board, { ...fields, title: 'ranked first, bar never signed' });
  const ready = store.addItem(board, { ...fields, title: 'frozen before bar readiness began' });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'early', items: [unready, ready] });
  store.claim(board, ready, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  store.release(board, ready, builder, 'Fixture returns the frozen item before bar readiness begins.', undefined, 'OTHER');
  order(true);
  setBarReady(board, { agentId: 'coordinator', enabled: true });
  assert.throws(() => store.claim(board, unready, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE }), { code: 'BAR_NOT_READY' }, 'claim refuses the unsigned bar');
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, ready, 'next uses the same readiness check as claim');
});
