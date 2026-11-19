/** Optional release size is enforced by real board moves over Git and SQLite [N26,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { MILESTONE_BUMP_ENGINE } from "../../../../state/index.js";
import { editMilestone } from '../../../../store/index.js';
import { editMilestoneItems } from '../../../../store/index.js';
import { roadmap } from '../../../../store/index.js';
import { provideCoordinatorMilestoneRelease } from '../../../../store/index.js';
import { workQueue } from '../../../../items/index.js';
import { milestoneRoadmap } from '../../../../roadmap/index.js';
import { listApiProjects } from '../../../../seats/index.js';
import { submitFixture } from '../../../../store/tests/fixtures/submit.js';
import { cellBoard } from '../../fixtures/cell-board.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../fixtures/cell-board.js';

// The store has no stats edge; these ships do not read the gauge, so a stub release stands in [C7].
provideCoordinatorMilestoneRelease(() => ({ gauge: null, previous: null, problem: null }));

const HOUR = 3_600_000;
const SETUP = 'fixture release setup';

/** A real Git project and its board, with a builder and a way to file items; no CLI, hooks or init. */
function fixture(t) {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  const builder = cellSeat(board, { lane: 'web', path: `${project.dir}/builder` }).id;
  const freeze = () => ({ text: 'Tracked work', digest: 'digest:tracked' });
  /** File an item and take it to the named state: open, accepted or landed. */
  const item = (title, state) => {
    const id = cellItem(board, { lane: 'web', title, criterion: 'Tracked work', specIds: ['G1'] }).item_id;
    if (state === 'open') return id;
    const commit = String(id).repeat(40).slice(0, 40);
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze });
    submitFixture(board, id, { agentId: builder, commit, tree: 'tree' });
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'checked it', head: commit, digest: 'digest:tracked', policy: 'any' });
    if (state === 'landed') store.merged(board, id, { agentId: 'coordinator', commit: project.git(project.repo, 'rev-parse', 'HEAD') });
    return id;
  };
  /** Add a milestone as the coordinator; fixture membership changes explicitly override automatic placement [B35]. */
  const add = (name, ids = []) => store.addMilestone(board, { agentId: 'coordinator', name, note: null, items: ids.map(String), ...(ids.length ? { reason: SETUP } : {}) });
  /** Edit a milestone's own fields as the coordinator, with the limit as the command takes it: text or `none`. */
  const edit = (name, change) => editMilestone(board, name, { agentId: 'coordinator', ...change });
  /** Add or swap members as the coordinator. */
  const members = (name, change) => editMilestoneItems(board, name, { agentId: 'coordinator', add: [], remove: [], reason: SETUP, ...change });
  /** The roadmap document the roadmap command prints, as a list of milestones. */
  const plan = (name) => milestoneRoadmap(project.repo, board, { ports: { ...store, roadmap, openBoard: openCellBoard, workQueue, listApiProjects } }).find(entry => entry.name === name);
  return { project, board, builder, item, add, edit, members, plan };
}

test('board.limit.milestone-with-limit-refuses-add-past: a milestone with a limit refuses an add past it and accepts a swap [N26,H16]', (t) => {
  const box = fixture(t);
  const first = box.item('Unstarted release work', 'open');
  const building = box.item('Already building', 'open');
  const incoming = box.item('New release work', 'open');
  store.claim(box.board, building, { agentId: box.builder, lane: 'web', leaseMs: HOUR,
    freeze: () => ({ text: 'Tracked work', digest: 'digest:tracked' }) });
  box.add('release', [first, building]);
  assert.equal(box.plan('release').limit, null, 'limits are off by default');
  box.edit('release', { limit: '2' });
  assert.equal(box.plan('release').limit, 2);
  assert.equal(box.plan('release').count, 2);
  assert.throws(() => box.members('release', { add: [String(incoming)] }), (error) => {
    assert.equal(error.code, 'MILESTONE_LIMIT');
    assert.match(error.message, /3 items.*limit 2/);
    assert.match(error.message, new RegExp(`unstarted.*#${first}`));
    assert.doesNotMatch(error.message, new RegExp(`#${building}(?:\\D|$)`), 'started work is not offered as a swap candidate');
    return true;
  });
  assert.deepEqual(store.milestones(box.board)[0].items, [first, building], 'refusal leaves the milestone unchanged');
  box.members('release', { add: [String(incoming)], swap: [String(first)] });
  assert.deepEqual(store.milestones(box.board)[0].items, [incoming, building]);
  assert.equal(box.plan('release').count, 2);
  assert.throws(() => box.members('release', { add: [String(first)], swap: ['999999'] }));
  assert.deepEqual(store.milestones(box.board)[0].items, [incoming, building], 'an invalid swap makes neither half of its change');
  box.edit('release', { limit: 'none', asPerson: true });
  box.members('release', { add: [String(first)] });
  assert.equal(box.plan('release').limit, null);
  assert.equal(box.plan('release').count, 3);
});


test('board.limit.caps-validate-edits-shipment-carry-and: [N26,H16] caps validate edits, shipment carry and historical replay without partial changes', (t) => {
  const box = fixture(t);
  const first = box.item('First', 'open');
  const second = box.item('Second', 'open');
  box.add('source', [first]);
  box.add('target');
  box.edit('target', { limit: '0' });
  for (const limit of ['-1', '1.5', 'abc', '9007199254740992']) {
    assert.throws(() => box.edit('target', { limit }), undefined, limit);
    assert.equal(store.milestones(box.board)[1].limit, 0);
  }
  const before = store.milestones(box.board);
  const ship = (name, next) => store.shipMilestone(box.board, name, { agentId: 'coordinator', coordinatorActions: true, commit: box.project.git(box.project.repo, 'rev-parse', 'main'), next });
  assert.throws(() => ship('source', 'target'));
  assert.deepEqual(store.milestones(box.board), before, 'a capped carry does not ship or move anything');
  box.edit('target', { limit: '1', asPerson: true });
  ship('source', 'target');
  assert.deepEqual(store.milestones(box.board)[1].items, [first]);
  assert.throws(() => box.edit('target', { newName: 'renamed', limit: '0' }));
  assert.equal(store.milestones(box.board)[1].name, 'target', 'invalid cap also rolls back the rename');
  const currentEngine = box.board.executionEngineVersion;
  try {
    box.board.executionEngineVersion = 1;
    editMilestoneItems(box.board, 'target', { agentId: 'coordinator', add: [second] });
    assert.deepEqual(store.milestones(box.board)[1].items, [first, second], 'historical uncapped moves replay unchanged');
    assert.throws(() => editMilestone(box.board, 'target', { agentId: 'coordinator', limit: 3 }), { code: 'ENGINE_VERSION' });
    assert.throws(() => editMilestoneItems(box.board, 'target', { agentId: 'coordinator', add: ['other#1'], swap: [first] }), { code: 'ENGINE_VERSION' });
  } finally { box.board.executionEngineVersion = currentEngine; }
});


test('board.limit.full-rollover-release-bumps-its-lowest-unstarted-item: [N26] a full rollover release bumps its lowest unstarted item to the top of the next release and keeps the add, recording the bump on the bumped item', (t) => {
  const box = fixture(t);
  const first = box.item('Unstarted release work', 'open');
  const building = box.item('Already building', 'open');
  const incoming = box.item('New release work', 'open');
  const waiting = box.item('Already waiting next', 'open');
  store.claim(box.board, building, { agentId: box.builder, lane: 'web', leaseMs: HOUR,
    freeze: () => ({ text: 'Tracked work', digest: 'digest:tracked' }) });
  box.add('release', [first, building]);
  box.add('next', [waiting]);
  box.edit('release', { limit: '2' });
  box.members('release', { add: [String(incoming)] });
  const [release, next] = store.milestones(box.board);
  assert.deepEqual(release.items, [building, incoming], 'the add is kept and the lowest unstarted item left');
  assert.deepEqual(next.items, [first, waiting], 'the bumped item sits at the top of the next release');
  const moved = store.itemThread(box.board, first).filter(entry => entry.kind === 'milestone_moved');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].detail.from, 'release');
  assert.equal(moved[0].detail.to, 'next');
});

test('board.limit.full-release-still-refuses-without-a-bump: [N26] explicit mode, an earlier engine and a release with no unstarted item still refuse MILESTONE_LIMIT', (t) => {
  const box = fixture(t);
  /** Claim an item with a seat of its own, since a seat holds one claim at a time. */
  const claimed = (title, seat) => {
    const id = box.item(title, 'open');
    const agentId = cellSeat(box.board, { lane: 'web', path: `${box.project.dir}/${seat}` }).id;
    store.claim(box.board, id, { agentId, lane: 'web', leaseMs: HOUR, freeze: () => ({ text: 'Tracked work', digest: 'digest:tracked' }) });
    return id;
  };
  const refused = (error) => error?.code === 'MILESTONE_LIMIT';
  const first = box.item('Unstarted release work', 'open');
  const second = box.item('More unstarted work', 'open');
  const incoming = box.item('New release work', 'open');
  box.add('explicit', [first, second]);
  box.add('later');
  box.edit('explicit', { limit: '2', mode: 'explicit' });
  assert.throws(() => box.members('explicit', { add: [String(incoming)] }), refused, 'explicit mode refuses');
  assert.deepEqual(store.milestones(box.board)[0].items, [first, second]);
  const busy = [claimed('Building one', 'one'), claimed('Building two', 'two')];
  box.add('busy', busy);
  box.edit('busy', { limit: '2' });
  assert.throws(() => box.members('busy', { add: [String(incoming)] }), refused, 'no unstarted item refuses');
  assert.deepEqual(store.milestones(box.board)[2].items, busy);
  box.edit('later', { limit: '0' });
  box.edit('explicit', { mode: 'rollover' });
  assert.throws(() => box.members('explicit', { add: [String(incoming)] }), refused, 'a next release with no room refuses');
  box.edit('later', { limit: 'none', asPerson: true });
  const currentEngine = box.board.executionEngineVersion;
  try {
    box.board.executionEngineVersion = MILESTONE_BUMP_ENGINE - 1;
    assert.throws(() => box.members('explicit', { add: [String(incoming)] }), refused, 'an earlier engine refuses');
  } finally { box.board.executionEngineVersion = currentEngine; }
});
