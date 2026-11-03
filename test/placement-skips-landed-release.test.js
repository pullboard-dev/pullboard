/** A new item is never placed in an unshipped milestone whose items have all landed [C7,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { addMilestone } from '../packages/store/index.js';
import { MILESTONE_PLACEMENT_ENGINE } from '../src/milestone-placement-engine.js';
import { fixtureBoard } from './board-fixture.js';

/** The milestone names that list an item. */
const placedIn = (board, id) => store.milestones(board).filter(entry => entry.items.includes(id)).map(entry => entry.name);

/** An earlier release, never recorded shipped, whose one C7 item has landed, and a later release with open work. */
function landedReleaseBoard(t) {
  const board = fixtureBoard(t);
  board.executionEngineVersion = MILESTONE_PLACEMENT_ENGINE - 1;
  const add = (title, extra = {}) => store.addItem(board, { by: 'coordinator', lane: 'core', title, route: 'strong', ...extra });
  const landed = add('Landed C7 work', { specIds: ['C7'] });
  const open = add('Open work');
  addMilestone(board, { agentId: 'coordinator', name: 'Old release', items: [landed] });
  addMilestone(board, { agentId: 'coordinator', name: 'Open release', items: [open] });
  board.db.prepare("UPDATE item SET item_status='verified' WHERE item_id=?").run(landed);
  delete board.executionEngineVersion;
  return { board, add };
}

test('a new C7 item skips an earlier unshipped release whose items all landed and goes to the later open one [C7,N26]', t => {
  const { board, add } = landedReleaseBoard(t);
  const fresh = add('New C7 work', { specIds: ['C7'] });
  assert.deepEqual(placedIn(board, fresh), ['Open release']);
  const lane = add('New lane work');
  assert.deepEqual(placedIn(board, lane), ['Open release'], 'the lane rule skips the landed release too');
});

test('a spec row in an earlier release that still holds unlanded work keeps placing there [C7,N26]', t => {
  const { board, add } = landedReleaseBoard(t);
  board.executionEngineVersion = MILESTONE_PLACEMENT_ENGINE - 1;
  const pending = add('Pending C7 work', { specIds: ['C7'] });
  store.editMilestoneItems(board, 'Old release', { agentId: 'coordinator', add: [pending], reason: 'fixture: pending work in the old release' });
  delete board.executionEngineVersion;
  const fresh = add('Another C7 item', { specIds: ['C7'] });
  assert.deepEqual(placedIn(board, fresh), ['Old release']);
});
