/** Main red items are always in focus, whatever milestone holds them [N2,B26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../index.js';
import { addMilestone } from '../../index.js';
import { roadmap } from '../../index.js';
import { setLineSetting } from '../../index.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { cellSeat } from '../fixtures/cell.js';

const HOUR = 60 * 60 * 1000;
/** The minimal frozen bar a claim needs. */
const FREEZE = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/**
 * A board whose focus milestone 0.9.4 holds one item, already claimed by a peer, with overflow off. `seed` adds the
 * other items first, since a new item joins the open milestone.
 */
function focused(t, seed) {
  const board = fixtureBoard(t);
  cellSeat(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = cellSeat(board, { lane: 'core', path: '/builder' }).id;
  const seeded = seed(board);
  const inFocus = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Focused' });
  addMilestone(board, { agentId: 'coordinator', reason: 'Set up focus', name: '0.9.4', items: [inFocus] });
  setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: '0.9.4', reason: 'Finish the release', window: { activeItems: 2 } });
  const peer = store.register(board, { lane: 'core', path: '/peer', route: 'strong' });
  store.claim(board, inFocus, { agentId: peer, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  return { board, builder, seeded };
}

test('clause 1: with focus set and overflow off, next offers a Main red item placed in another milestone [N2,B26,C7]', t => {
  const { board, builder, seeded: red } = focused(t, board => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Main red: apps/cli/journeys/land/main.test.js', route: 'strong' });
    addMilestone(board, { agentId: 'coordinator', reason: 'Later release', name: '0.9.5', items: [id] });
    return id;
  });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item?.item_id, red);
});

test('clause 1: with focus set and overflow off, next offers a Main red item in no milestone [N2,B26,C7]', t => {
  const { board, builder, seeded: red } = focused(t, board => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Main red: test/next.test.js', route: 'strong' }));
  assert.equal(roadmap(board).some(milestone => milestone.items.some(item => item.id === red)), false, 'the Main red item is in no milestone');
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item?.item_id, red);
});

test('clause 2: other items outside the focus milestone stay hidden when overflow is off [N2,B26,C7]', t => {
  const { board, builder } = focused(t, board => {
    const later = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Later work' });
    addMilestone(board, { agentId: 'coordinator', reason: 'Later release', name: '0.9.5', items: [later] });
    store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Unplaced work' });
  });
  const result = store.nextFor(board, { agentId: builder, lane: 'core', observeIdle: true });
  assert.equal(result.item, null);
  assert.ok(result.reasons.includes('0.9.4 is in focus; nothing is free for you; overflow is off.'), result.reasons.join('; '));
});
