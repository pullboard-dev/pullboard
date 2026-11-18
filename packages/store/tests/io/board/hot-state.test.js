/** board.hotState keeps open and recent items in the built state and counts older finished ones [C7,#9725]. @pullboard-test-input source-cell store */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOT_RECENT_MS } from '../../../src/io/board/state.js';
import { hotStateItems } from '../../../src/io/board/state.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const DAY = 24 * 3600_000;
const at = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();

/** A built state: two open items, one fresh and two stale finished items, and the fields a build carries besides items. */
function built() {
  return {
    board: 'main',
    agents: [{ agent_id: 'core-1' }],
    items: [
      { id: 1, status: 'open', updatedAt: at(90) },
      { id: 2, status: 'claimed', updatedAt: at(40) },
      { id: 3, status: 'withdrawn', updatedAt: at(1) },
      { id: 4, status: 'withdrawn', updatedAt: at(30) },
      { id: 5, status: 'withdrawn', updatedAt: at(60) },
    ],
  };
}

test('store.io-board-hot-state.with-board-hotstate-on-the-state: clause 1: with board.hotState on the state holds only open and recent items and counts the finished ones as the full build reports them [C7,#9725]', () => {
  const full = built();
  const hot = hotStateItems(built(), { enabled: true, now: NOW });
  assert.deepEqual(hot.items.map(item => item.id), [1, 2, 3], 'open items and the recently finished item stay whole');
  const finishedInFull = full.items.filter(item => item.status === 'withdrawn' && NOW - Date.parse(item.updatedAt) > HOT_RECENT_MS);
  assert.deepEqual(hot.finishedCounts, { withdrawn: finishedInFull.length }, 'the count equals the finished items the full build holds');
  assert.equal(hot.items.length + Object.values(hot.finishedCounts).reduce((sum, n) => sum + n, 0), full.items.length, 'every item is kept or counted');
  assert.equal(hot.board, 'main', 'the rest of the state is untouched');
  assert.deepEqual(hot.agents, full.agents);
});

test('store.io-board-hot-state.with-board-hotstate-off-the-state: clause 2: with board.hotState off the state is identical to today, with no new field [C7,#9725]', () => {
  const state = built();
  const off = hotStateItems(state, { enabled: false, now: NOW });
  assert.equal(off, state, 'the same object comes back');
  assert.deepEqual(off, built());
  assert.equal('finishedCounts' in off, false);
  assert.equal(hotStateItems(built(), { enabled: undefined, now: NOW }).finishedCounts, undefined, 'only an exact true turns it on');
});
