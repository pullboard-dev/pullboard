/** The roadmap lists a milestone's open items in pullboard queue order, with queue positions [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { openBoard } from '../../../../board/tests/fixtures/board.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import {
  addMilestone,
  orderMilestoneItems,
  roadmap,
} from '../../../index.js';
import { eligibilityProblem } from '../../../../verify/index.js';
import { milestoneRoadmap } from '../../../../roadmap/index.js';
import { workQueue } from '../../../../items/index.js';
import { milestoneItemIds } from '../../../src/io/board/state.js';

test('store.io-board-order.roadmap-lists-open-items-in-queue: roadmap lists open items in queue order with pins applied and agrees with queue on every item [C7]', (t) => {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  store.register(board, { lane: 'core', path: '/strong', route: 'strong' });
  const add = (title) => store.addItem(board, { by: 'coordinator', lane: 'core', title, route: 'strong' });
  const ids = ['First added', 'Second added', 'Third added', 'Fourth added'].map(add);
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'now', items: ids });
  orderMilestoneItems(board, 'now', { agentId: 'coordinator', items: [ids[3]], place: 'pin', reason: 'needed first' });
  orderMilestoneItems(board, 'now', { agentId: 'coordinator', items: [ids[0]], place: 'sink', reason: 'waits on a design answer' });
  const queue = workQueue(board, { buildOrder: store.buildOrder, canTake: store.canTake, listItems: store.listItems, milestonePriorities: store.milestonePriorities,
    milestones: store.milestones, roadmap: roadmap, ROUTES: store.ROUTES, foreignBlockers: store.foreignBlockers, eligibilityProblem });
  const queued = queue.releases[0].items.map(item => item.id);
  const [shown] = milestoneRoadmap('/unused', board, { projects: () => [], ports: { ...store, roadmap, openBoard, workQueue } });
  assert.equal(queued[0], ids[3], 'the queue puts the pinned item first');
  assert.deepEqual(shown.items.map(entry => entry.id), queued, 'roadmap and queue agree on every open item and its order');
  assert.deepEqual(shown.items.map(entry => entry.position), queued.map((_, index) => index + 1), 'each item carries its queue position');
  assert.notDeepEqual(queued, ids, 'the seeded order differs from add order');
});

// fixture-subject: addItem (a store unit test of the board state's milestone rows over seeded items)
test('store.io-board-order.the-board-state-lists-each-local: clause 1: the board state lists each local milestone item by id and leaves title, status and progress to the state items [C7]', (t) => {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  store.register(board, { lane: 'core', path: '/strong', route: 'strong' });
  const ids = ['One', 'Two', 'Three'].map(title => store.addItem(board, { by: 'coordinator', lane: 'core', title, route: 'strong' }));
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'now', items: ids });
  const [shown] = milestoneRoadmap('/unused', board, { projects: () => [], ports: { ...store, roadmap, openBoard, workQueue } });
  const [slim] = milestoneItemIds([{ ...shown, items: [...shown.items, { id: 'other#7', title: 'Elsewhere', status: 'open', state: 'open' }] }]);
  assert.deepEqual(slim.items.slice(0, -1), shown.items.map(entry => ({ id: entry.id, state: entry.state, position: entry.position })), 'each local item keeps its id, state and queue position');
  assert.ok(slim.items.slice(0, -1).every(entry => !('title' in entry) && !('status' in entry) && !('progress' in entry)), 'no title, status or progress is copied');
  assert.deepEqual(slim.items.at(-1), { id: 'other#7', title: 'Elsewhere', status: 'open', state: 'open' }, 'an item on another board keeps its whole row');
  assert.equal(slim.progress, shown.progress, 'the milestone keeps its own summary and progress');
});
