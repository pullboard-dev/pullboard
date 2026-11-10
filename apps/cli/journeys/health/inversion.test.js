import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { healthReport } from '../../../../packages/health/index.js';
import { dispatchHealth } from '../../../../packages/sentinels/index.js';
import {
  fixture,
  cli,
} from '../../tests/fixtures/next/take.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';

/** Observe the native SQLite board with its real queue and private fixture clock. */
function findings(box) {
  return healthReport({ db: box.board.db, root: box.root, config: box.config, now: box.clock.now(), dispatchHealth }).stuck;
}

/** Put a fresh live claim behind a genuinely free earlier item. */
async function ranked(t) {
  const box = await fixture(t);
  const earlier = box.add('Earlier work');
  const later = box.add('Later work');
  box.claim(later, box.seats.actor);
  return { box, earlier, later };
}

test('a fresh claim behind free earlier work retains its rank inversion [N2,B13]', async t => {
  const { box, earlier, later } = await ranked(t);
  const entry = findings(box).find(row => row.key === `RANK_INVERSION:item:${later}`);
  assert.equal(entry?.owner.who, box.seats.actor.id);
  assert.equal(entry.detail.ahead, earlier);
  assert.equal(entry.command, `pullboard release ${later} --reason ROUTED_ELSEWHERE`);
});

test('a genuine native check receipt since the claim protects proved work without changing its receipt [N2,B13,C7]', async t => {
  const { box, later } = await ranked(t);
  const result = await cli(box, box.seats.actor.path, ['check', String(later), '--yes']);
  assert.equal(result.code, 0, JSON.stringify(result));
  const receipts = store.proofReceipts(box.board, later);
  assert.ok(receipts.length, 'the actual native check must produce its immutable receipt');
  assert.ok(!findings(box).some(row => row.key === `RANK_INVERSION:item:${later}`));
  assert.deepEqual(store.proofReceipts(box.board, later), receipts, 'health leaves native receipt bytes untouched');
});

test('rejected work nudges its active last builder instead of an occupied holder [N2,B13]', async t => {
  const { box, earlier, later } = await ranked(t);
  box.submit(earlier); // Explicit synthetic board-state setup; it claims no gate execution.
  store.verify(box.board, earlier, { agentId: box.seats.outside.id, decision: 'REJECT', head: store.getItem(box.board, earlier).item_commit, policy: 'any', digest: store.getItem(box.board, earlier).item_frozen_digest, reason: 'TEST_FAILURE', clause: 'The real fixture succeeds.', note: 'Synthetic lifecycle fixture rejection' });
  heartbeatSeat(box.board, box.seats.builder.id);
  const rows = findings(box);
  assert.ok(!rows.some(row => row.key === `RANK_INVERSION:item:${later}`));
  const nudge = rows.find(row => row.cause === 'IDLE_AGENT' && row.detail.item === earlier);
  assert.equal(nudge?.owner.who, box.seats.builder.id);
  assert.equal(nudge.command, `pullboard claim ${earlier}`);
});
