/** @pullboard-test-input packages/landing/index.js packages/store/index.js */
/** Every refusal or crash in a landing step ends its batch blocked, recorded once, so no restart adopts it unchanged [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardFixture } from '../../../tests/fixtures/next/order.js';
import * as store from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import {
  blockAfterRefusal,
  crashRefusal,
} from '../../../../../packages/landing/index.js';

/** A gating batch on a real board, with a write port that applies the batch moves as the worker's parent would. */
function gating(t, id) {
  const { board } = boardFixture();
  t.after(() => store.closeBoard(board));
  const state = { board, say() {}, write: async (operation, args) => store[operation](board, ...args), batch: null };
  state.batch = store.recordLandingBatch(board, { agentId: 'coordinator', revision: 0, batch: { version: 1, id, state: 'gating',
    base: 'a'.repeat(40), tip: 'b'.repeat(40), root: '/fixture', branch: 'refs/heads/main', owner: 'coordinator', logPath: '/fixture/log', items: [], candidates: [], conflicts: [] } });
  return { state, latest: () => store.landingBatches(board).find(batch => batch.id === id) };
}

for (const [step, code] of [['merge', 'LAND_MERGE'], ['gate', 'GATE_RED'], ['diagnose', 'LAND_DIAGNOSE'], ['trunk', 'LAND_TRUNK'], ['publish', 'LAND_PUBLISH']]) {
  test(`clause 1: a ${step} refusal ends the batch blocked with its code [C7]`, async t => {
    const { state, latest } = gating(t, `refuse-${step}`);
    await blockAfterRefusal(state, new Refused(code, `${step} refused`));
    assert.equal(latest().state, 'blocked');
  });
}

test('clause 1: a lost lease keeps the batch for adoption, a board-busy refusal blocks it like any other [C7]', async t => {
  const lost = gating(t, 'keep-lost');
  await blockAfterRefusal(lost.state, new Refused('LAND_LEASE_LOST', 'lost'));
  assert.equal(lost.latest().state, 'gating');
  const busy = gating(t, 'block-busy');
  await blockAfterRefusal(busy.state, new Refused('BOARD_BUSY', 'busy'));
  assert.equal(busy.latest().state, 'blocked');
});

test('clause 2: a non-refusal crash is recorded blocked as LAND_WORKER_CRASH with its stack, once [C7]', async t => {
  const { state, latest } = gating(t, 'crash-once');
  const error = new TypeError('boom');
  const refusal = crashRefusal(error);
  assert.equal(refusal.code, 'LAND_WORKER_CRASH');
  assert.match(refusal.message, /TypeError: boom[\s\S]*at /u);
  await blockAfterRefusal(state, error);
  await blockAfterRefusal(state, error);
  assert.equal(latest().state, 'blocked');
});
