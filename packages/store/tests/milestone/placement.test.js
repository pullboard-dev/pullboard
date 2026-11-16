/** The board places a new item in a milestone by rule, shows why, and records any override's reason [N26,B35]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../index.js';
import { addMilestone } from '../../index.js';
import { editMilestoneItems } from '../../index.js';
import { MILESTONE_PLACEMENT_ENGINE } from '../../../state/light.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';

/** A default board with two releases, seeded from work recorded before automatic placement. */
function placementBoard(t) {
  const board = fixtureBoard(t);
  board.executionEngineVersion = MILESTONE_PLACEMENT_ENGINE - 1;
  const add = (title, extra = {}) => store.addItem(board, { by: 'coordinator', lane: 'core', title, route: 'strong', ...extra });
  const early = add('Early work', { specIds: ['G1'] });
  const late = add('Late work', { specIds: ['G2'] });
  addMilestone(board, { agentId: 'coordinator', name: 'N', items: [early] });
  addMilestone(board, { agentId: 'coordinator', name: 'M', items: [late] });
  delete board.executionEngineVersion;
  return { board, add, early, late };
}

/** The milestone names that list an item. */
const placedIn = (board, id) => store.milestones(board).filter(entry => entry.items.includes(id)).map(entry => entry.name);
/** The item's recorded placement events. */
const placements = (board, id) => store.itemThread(board, id).filter(row => row.kind === 'milestone_placed');

test('an item waiting on an item in release N is placed in N or later [N26,B35]', t => {
  const { board, add, late } = placementBoard(t);
  const follower = add('Follows the late work', { after: [late] });
  assert.deepEqual(placedIn(board, follower), ['M'], 'never earlier than what it waits on, though the current release is N');
  const [event] = placements(board, follower);
  assert.equal(event.detail.rule, 'dependencies');
  assert.deepEqual(event.detail.inputs.after, [{ id: late, milestone: 'M' }]);
  assert.match(event.detail.note, /placed in M by dependencies; waits on #\d+ in M; lane core -> N/u, 'the rule and its inputs are shown on the item');
});

test('an item serving a spec row in release M lands in M [N26,B35]', t => {
  const { board, add } = placementBoard(t);
  const row = add('Serves the later row', { specIds: ['G2'] });
  assert.deepEqual(placedIn(board, row), ['M']);
  assert.equal(placements(board, row)[0].detail.rule, 'spec rows');
  const plain = add('Serves nothing yet');
  assert.deepEqual(placedIn(board, plain), ['N'], 'without rows or waits it joins its lane release');
});

test('a manual placement of a placed item is refused, and an override records its reason [N26,B35]', t => {
  const { board, add } = placementBoard(t);
  const item = add('Placed by the board');
  assert.deepEqual(placedIn(board, item), ['N']);
  assert.throws(() => editMilestoneItems(board, 'M', { agentId: 'coordinator', add: [item] }),
    error => error.code === 'MILESTONE_PLACED' && error.message.includes('the board places items'));
  editMilestoneItems(board, 'M', { agentId: 'coordinator', add: [item], reason: 'the person moved it to the later release' });
  assert.deepEqual(placedIn(board, item), ['M']);
  const override = placements(board, item).at(-1);
  assert.equal(override.detail.rule, 'override');
  assert.equal(override.detail.reason, 'the person moved it to the later release');
});

test('a default board places new items without a setting or coordinator placement move [N26,B35]', t => {
  const board = fixtureBoard(t);
  addMilestone(board, { agentId: 'coordinator', name: 'N', items: [] });
  const item = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Default placement', route: 'strong' });
  assert.deepEqual(placedIn(board, item), ['N']);
  assert.equal(placements(board, item).length, 1);
  assert.equal(placements(board, item)[0].detail.position, 1);
  assert.deepEqual(store.milestones(board)[0].order, [item]);
  assert.throws(() => editMilestoneItems(board, 'N', { agentId: 'coordinator', add: [item] }),
    error => error.code === 'MILESTONE_PLACED' && error.message.includes('the board places items'));
});

test('a person override moves the automatic assignment and records its reason [N26,B35,H16]', t => {
  const { board, add } = placementBoard(t);
  const item = add('Person moves it');
  editMilestoneItems(board, 'M', { agentId: 'person', add: [item], reason: 'the person selects this release' });
  assert.deepEqual(placedIn(board, item), ['M']);
  assert.equal(placements(board, item).at(-1).by, 'person');
  assert.equal(placements(board, item).at(-1).detail.reason, 'the person selects this release');
});

test('historical adds retain their recorded lack of automatic placement [N26,B35,H16]', t => {
  const board = fixtureBoard(t);
  board.executionEngineVersion = MILESTONE_PLACEMENT_ENGINE - 1;
  addMilestone(board, { agentId: 'coordinator', name: 'N', items: [] });
  const item = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Historical', route: 'strong' });
  assert.deepEqual(placedIn(board, item), []);
  assert.equal(placements(board, item).length, 0);
  editMilestoneItems(board, 'N', { agentId: 'coordinator', add: [item] });
  assert.deepEqual(placedIn(board, item), ['N']);
});

test('plain catalog seeding and ordering of new work require recorded overrides [N26,B35]', t => {
  const board = fixtureBoard(t);
  const item = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'New catalog input', route: 'strong' });
  assert.match(placements(board, item)[0].detail.note, /no suitable unshipped milestone/u);
  assert.equal(placements(board, item)[0].detail.inputs.lane.lane, 'core');
  assert.throws(() => addMilestone(board, { agentId: 'coordinator', name: 'N', items: [item] }), { code: 'MILESTONE_PLACED' });
  addMilestone(board, { agentId: 'coordinator', name: 'N', items: [item], reason: 'initial release catalog' });
  assert.throws(() => store.orderMilestoneItems(board, 'N', { agentId: 'coordinator', items: [item] }), { code: 'MILESTONE_PLACED' });
  store.orderMilestoneItems(board, 'N', { agentId: 'person', items: [item], reason: 'the person sets release priority' });
  assert.equal(placements(board, item).at(-1).detail.reason, 'the person sets release priority');
});

test('automatic order keeps an unranked prerequisite ahead of new work [N26,B35]', t => {
  const { board, add, early } = placementBoard(t);
  const ranked = add('Explicitly ranked');
  store.orderMilestoneItems(board, 'N', { agentId: 'coordinator', items: [ranked], reason: 'fixture priority' });
  const follower = add('Depends on unranked work', { after: [early] });
  const order = store.milestones(board).find(entry => entry.name === 'N').order;
  assert.ok(order.indexOf(early) < order.indexOf(follower));
  assert.equal(order[0], ranked);
});
