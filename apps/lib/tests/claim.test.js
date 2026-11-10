/** next and claim agree on held: a lapsed claim whose own gate is in flight is never listed open [C7,#3121]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../../packages/jobs/index.js';
import * as store from '../../../packages/store/index.js';
import { fixtureBoard } from '../../cli/tests/fixtures/board.js';

const freeze = () => ({ text: '{}', digest: 'lapsed-gated-claim-fixture' });

/** A board on a hand-moved clock with a lapsed web-1 claim on the first item and an open second item. */
function lapsedClaim(t) {
  let at = Date.parse('2026-11-04T12:00:00.000Z');
  const board = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  const held = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'lapsed claim' });
  const other = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'other work' });
  store.claim(board, held, { agentId: 'web-1', lane: 'web', leaseMs: 60_000, freeze });
  // Read once while the lease lives, so a remembered list exists that must not outlive it.
  assert.equal(store.listItems(board, { lane: 'web' }).find(item => item.item_id === held).item_status, 'claimed');
  at += 120_000;
  return { board, held, other };
}

test('a lapsed claim with a queued gate is not offered by next, which returns other work, and claim agrees [C7,#3121]', t => {
  const { board, held, other } = lapsedClaim(t);
  recordSubmitHandoff(board.db, held, { id: `fixture-${held}`, commit: 'a'.repeat(40), agentId: 'web-1', state: 'queued' });
  const listed = store.listItems(board, { lane: 'web' }).find(item => item.item_id === held);
  assert.equal(listed.item_status, 'claimed', 'the gate keeps the claim held in the list');
  assert.equal(listed.item_owner, 'web-1');
  const offered = store.nextFor(board, { agentId: 'web-2', lane: 'web' });
  assert.equal(offered.item?.item_id, other, offered.reasons.join(' | '));
  assert.throws(() => store.claim(board, held, { agentId: 'web-2', lane: 'web', leaseMs: 60_000, freeze }), { code: 'HELD' });
});

test('a lapsed claim with no gate in flight is listed open and claimable [C7,#3121]', t => {
  const { board, held } = lapsedClaim(t);
  const listed = store.listItems(board, { lane: 'web' }).find(item => item.item_id === held);
  assert.equal(listed.item_status, 'open', 'the remembered list expired with the lease');
  assert.equal(listed.item_owner, null);
  const claimed = store.claim(board, held, { agentId: 'web-2', lane: 'web', leaseMs: 60_000, freeze });
  assert.equal(store.getItem(board, held).item_owner, 'web-2', JSON.stringify(claimed));
});
