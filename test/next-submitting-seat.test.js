/** A seat whose submit gate is queued takes new work, and its trailers stay accepted [C7,#2882]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { submittedClaimsFallback } from '../apps/cli/src/shell/commands/hook.js';
import { fixtureBoard } from './board-fixture.js';

const { dispatchWork } = store;

/** Claim one item as web-1 and record a queued submit handoff for it, as `submit --no-next` does. */
function submitting(t, state = 'queued') {
  const board = fixtureBoard(t);
  const first = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'First', criterion: 'First', check: 'true' });
  const second = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Second', criterion: 'Second', check: 'true' });
  const seat = store.register(board, { lane: 'web', path: '/tmp/next-submitting-seat' });
  store.claim(board, first, { agentId: seat, lane: 'web', leaseMs: 3_600_000, head: 'a'.repeat(40), freeze: item => ({ text: item.item_title, digest: `digest:${item.item_title}` }) });
  const claimed = store.itemById(board, first);
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`submit_handoff:${first}`,
    JSON.stringify({ state, agentId: seat, digest: claimed.item_frozen_digest }));
  return { board, first, second, seat };
}

test('dispatch gives a seat with a running submit handoff a different item, never its held one [C7,#2882]', t => {
  const { board, first, second, seat } = submitting(t);
  const picked = dispatchWork(board, store.agentById(board, seat));
  assert.equal(picked.held, false, 'the output never says "you hold" with a --wait hint');
  assert.equal(picked.item?.item_id, second);
  assert.notEqual(picked.item?.item_id, first);
});

test('dispatch still reports the held claim once the handoff is red [C7,#2882]', t => {
  const { board, first, seat } = submitting(t, 'red');
  const picked = dispatchWork(board, store.agentById(board, seat));
  assert.equal(picked.held, true);
  assert.equal(picked.item.item_id, first);
});

test('commit-msg claims keep the submitted item while its handoff runs [C7,#2882]', () => {
  const submitted = { item_id: 1 }, live = { item_id: 2 };
  const pending = item => item.item_id === 1;
  assert.deepEqual(submittedClaimsFallback([submitted], pending), [submitted], 'a trailer for the submitted item is accepted');
  assert.deepEqual(submittedClaimsFallback([submitted, live], pending), [live], 'a live claim still wins');
});
