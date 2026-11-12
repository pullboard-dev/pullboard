/** The red notice reads the item through current() and says the claim lapsed when it did [SM13]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem } from '../../../../index.js';
import { claim } from '../../../../index.js';
import { queuedReds } from '../../../../index.js';
import { queuedRedLines } from '../../../../index.js';
import { register } from '../../../../index.js';
import { recordSubmitHandoff } from '../../../../../jobs/index.js';
import { fixtureBoard } from '../../../../../../apps/cli/tests/fixtures/board.js';

const MINUTE = 60_000;

/** A claimed item whose queued gate went red; the claim has `leaseMs` left. */
function redFixture(t, leaseMs) {
  const board = fixtureBoard(t);
  register(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = register(board, { lane: 'core', path: '/builder', route: 'strong' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Red notice fixture', route: 'strong' });
  claim(board, id, { agentId: builder, lane: 'core', leaseMs: MINUTE, freeze: (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` }) });
  const item = board.db.prepare('SELECT item_title FROM item WHERE item_id=?').get(id);
  recordSubmitHandoff(board.db, id, { version: 1, id: 'job-1', agentId: builder, commit: 'c'.repeat(40), digest: `digest:${item.item_title}`, state: 'red', error: { code: 'TEST_FAILURE', message: 'boom', next: 'fix it' } });
  board.db.prepare('UPDATE item SET item_lease_until=? WHERE item_id=?').run(new Date(Date.now() + leaseMs).toISOString(), id);
  return { board, builder, id };
}

test('clause 1: queuedReds reads the item through current(), and the notice says the claim lapsed when it did [SM13]', (t) => {
  const lapsed = redFixture(t, -MINUTE);
  const [red] = queuedReds(lapsed.board, lapsed.builder);
  assert.equal(red.lapsed, true);
  assert.match(queuedRedLines([red]).join('\n'), /claim lapsed at/);
  const held = redFixture(t, 30 * MINUTE);
  const [live] = queuedReds(held.board, held.builder);
  assert.equal(live.lapsed, false);
  assert.match(queuedRedLines([live]).join('\n'), /stays claimed by you until/);
});
