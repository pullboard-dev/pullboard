/** Main red items are always in focus, whatever milestone holds them [N2,B26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../store/index.js';
import { addMilestone } from '../../store/index.js';
import { roadmap } from '../../store/index.js';
import { setLineSetting } from '../../store/index.js';
import { boardFixture } from '../../../test/next-order-fixture.js';
import { HOUR } from '../../../test/next-order-fixture.js';
import { FREEZE } from '../../../test/next-order-fixture.js';

/**
 * A board whose focus milestone 0.9.4 holds one item, already claimed by a peer, with overflow off. `seed` adds the
 * other items first, since a new item joins the open milestone.
 */
function focused(t, seed) {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
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
    const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Main red: test/land.test.js', route: 'strong' });
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
