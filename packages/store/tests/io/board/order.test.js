/** The roadmap lists a milestone's open items in pullboard queue order, with queue positions [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { apiBoardOpeners } from '../../../../../apps/cli/tests/fixtures/board.js';
import { fixtureBoard } from '../../../../../apps/cli/tests/fixtures/board.js';
import {
  addMilestone,
  orderMilestoneItems,
  roadmap,
} from '../../../index.js';
import { eligibilityProblem } from '../../../../verify/index.js';
import { milestoneRoadmap } from '../../../../roadmap/index.js';
import { workQueue } from '../../../../items/index.js';

const { openBoard } = apiBoardOpeners;

test('roadmap lists open items in queue order with pins applied and agrees with queue on every item [C7]', (t) => {
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
