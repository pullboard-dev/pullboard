/** Focus never hides finished, green-gated work from review, while builds stay inside the focus [C7, #2961]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { boardFixture, submitted, HOUR, FREEZE } from './next-order-fixture.js';

/**
 * A real board plus a step that puts focus on 0.9.3 with overflow off. The 0.9.3 milestone holds one
 * focused item; the caller adds its outside items first, since the setting's window counts later work.
 */
function focusedBoard(t) {
  const { board, builder, reviewer } = boardFixture();
  t.after(() => store.closeBoard(board));
  const focused = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Focused' });
  /** Turn focus on with overflow off. */
  const focus = () => {
    store.addMilestone(board, { agentId: 'coordinator', reason: 'Set up focus', name: '0.9.3', items: [focused] });
    store.setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: { name: '0.9.3', overflow: false },
      reason: 'Finish the release', window: { activeItems: 2 } });
  };
  return { board, builder, reviewer, focused, focus };
}

/** Record a green gate at the item's submitted head, the way the submit queue does. */
function green(board, id) {
  const head = store.getItem(board, id).item_commit;
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(`submit_handoff:${id}`, JSON.stringify({ commit: head, agentId: 'builder', state: 'green' }));
}

test('with focus on and overflow off, next --verify still offers a green submission outside the focus [C7,#2961]', t => {
  const { board, builder, reviewer, focus } = focusedBoard(t);
  const outside = submitted(board, builder, 'Outside review', 'strong', 5);
  focus();
  assert.ok(store.getItem(board, outside).item_commit, 'the submission records its head');
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item, null, 'an ungated outside submission stays behind the focus');
  green(board, outside);
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item?.item_id, outside);
});

test('next never offers an out-of-focus open item to build while focus is on and overflow is off [C7,#2961]', t => {
  const { board, builder, focused, focus } = focusedBoard(t);
  const outside = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Outside build' });
  focus();
  const peer = store.register(board, { lane: 'core', path: '/peer', route: 'strong' });
  store.claim(board, focused, { agentId: peer, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const result = store.nextFor(board, { agentId: builder, lane: 'core', observeIdle: true });
  assert.equal(result.item, null);
  assert.ok(result.reasons.includes('0.9.3 is in focus; nothing is free for you; overflow is off.'), result.reasons.join(' | '));
  assert.equal(store.getItem(board, outside).item_status, 'open');
});
