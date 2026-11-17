/** @pullboard-test-input source-cell store */
// fixture-subject: addItem (a store unit test of nextFor over seeded items)
/** An idle answer can name what each waiting item waits on, behind an option [C7,N2,#9619]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../index.js';
import { addMilestone } from '../../index.js';
import { setLineSetting } from '../../index.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { cellSeat } from '../fixtures/cell.js';

const HOUR = 60 * 60 * 1000;
/** The minimal frozen bar a claim needs. */
const FREEZE = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/** A board with one claimed blocker and `count` open core items that each wait on it; `focus` puts them all in a focus milestone. */
function waiting(t, { count = 4, focus = false } = {}) {
  const board = fixtureBoard(t);
  cellSeat(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = cellSeat(board, { lane: 'core', path: '/builder' }).id;
  const peer = store.register(board, { lane: 'core', path: '/peer', route: 'strong' });
  const blocker = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Blocker' });
  store.claim(board, blocker, { agentId: peer, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const followers = Array.from({ length: count }, (_, index) => store.addItem(board, { by: 'coordinator', lane: 'core', title: `Follower ${index}`, after: [blocker] }));
  if (focus) {
    addMilestone(board, { agentId: 'coordinator', reason: 'Set up focus', name: '0.9.4', items: [blocker, ...followers] });
    setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: '0.9.4', reason: 'Finish the release', window: { activeItems: 2 } });
  }
  return { board, builder, blocker, followers };
}

test('clause 1: with idleBlockers on and no free item, nextFor returns at most 3 { item, waitsOn } rows [C7,N2]', t => {
  const { board, builder, blocker, followers } = waiting(t);
  const result = store.nextFor(board, { agentId: builder, lane: 'core', idleBlockers: true });
  assert.equal(result.item, null);
  assert.equal(result.blockers.length, 3, 'four waiting items give three rows');
  for (const row of result.blockers) {
    assert.ok(followers.includes(row.item), `#${row.item} is a waiting item`);
    assert.equal(row.waitsOn, blocker, 'each names the unverified item it waits on');
  }
});

test('clause 2: the focus idle answer keeps the blockers with overflow off [C7,N2]', t => {
  const { board, builder, blocker } = waiting(t, { count: 2, focus: true });
  const result = store.nextFor(board, { agentId: builder, lane: 'core', idleBlockers: true });
  assert.equal(result.item, null);
  assert.ok(result.reasons.some(line => line.includes('is in focus')), result.reasons.join('; '));
  assert.equal(result.blockers.length, 2);
  assert.ok(result.blockers.every(row => row.waitsOn === blocker));
});

test('clause 3: with the option off the result has no blockers key and is unchanged [C7,N2]', t => {
  for (const focus of [false, true]) {
    const { board, builder } = waiting(t, { count: 2, focus });
    const plain = store.nextFor(board, { agentId: builder, lane: 'core' });
    assert.equal('blockers' in plain, false);
    assert.deepEqual(plain, store.nextFor(board, { agentId: builder, lane: 'core', idleBlockers: false }));
  }
});
