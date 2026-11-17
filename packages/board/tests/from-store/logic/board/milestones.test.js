/** The roadmap counts what landed on main, and shipping a milestone carries the rest forward [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { addMilestone } from '../../../../../store/index.js';
import { editMilestone } from '../../../../../store/index.js';
import { editMilestoneItems } from '../../../../../store/index.js';
import { exportBoard } from '../../../../../store/index.js';
import { importBoard } from '../../../../../store/index.js';
import { orderMilestoneItems } from '../../../../../store/index.js';
import { roadmap } from '../../../../../store/index.js';
import { shipMilestone } from '../../../../../store/index.js';
import { ENGINE_VERSION } from '../../../../../state/index.js';
import { appliedSequence } from '../../../../../state/index.js';
import { applyEngineMove } from '../../../../../state/index.js';
import { applyRelayMove } from '../../../../../state/index.js';
import { engineReceipt } from '../../../../../state/index.js';
import { prepareEngineMove } from '../../../../../state/index.js';
import { MILESTONE_QUEUE_ORDER_ENGINE } from '../../../../../state/light.js';
import { dependencyLabel } from '../../../../../items/index.js';
import { itemFileCollisions } from '../../../../../items/index.js';
import { localDependencyIds } from '../../../../../items/index.js';
import { workQueue } from '../../../../../items/index.js';
import { milestoneRoadmap } from '../../../../../roadmap/index.js';
import { listApiProjects } from '../../../../../seats/index.js';
import { eligibilityProblem } from '../../../../../verify/index.js';
import { submitFixture } from '../../../../../store/tests/fixtures/submit.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../fixtures/cell-board.js';

const HOUR = 3_600_000;
const SETUP = 'fixture release setup';

/**
 * A real repo on main with a board and a builder agent, and items in each state the roadmap tells apart: landed (verified
 * with a merge commit), accepted (verified only) and open. No CLI, hooks or init run, and git is isolated from the machine.
 */
function fixture(t) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  const builder = cellSeat(board, { lane: 'web', path: `${project.dir}/builder` }).id;
  const freeze = item => ({ text: JSON.stringify({ title: item.item_title, criterion: item.item_criterion, rows: [] }), digest: 'digest:tracked' });
  const git = (...args) => project.git(project.repo, ...args);
  /** File an item and take it to the named state: open, accepted or landed. */
  const item = (title, state) => {
    const id = cellItem(board, { lane: 'web', title, criterion: 'Tracked work', specIds: ['G1'] }).item_id;
    if (state === 'open') return id;
    const commit = String(id).repeat(40).slice(0, 40);
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze });
    submitFixture(board, id, { agentId: builder, commit, tree: 'tree' });
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'checked it', head: commit, digest: 'digest:tracked', policy: 'any' });
    if (state === 'landed') store.merged(board, id, { agentId: 'coordinator', commit: git('rev-parse', 'HEAD') });
    return id;
  };
  /** Add a milestone as the coordinator; fixture membership changes explicitly override automatic placement [B35]. */
  const add = (name, ids = []) => addMilestone(board, { agentId: 'coordinator', name, note: null, items: ids.map(String), ...(ids.length ? { reason: SETUP } : {}) });
  /** Add or remove members as the coordinator. */
  const members = (name, change) => editMilestoneItems(board, name, { agentId: 'coordinator', add: [], remove: [], reason: SETUP, ...change });
  /** Ship a milestone as the coordinator at main's commit, as the ship command does. */
  const ship = (name, next) => shipMilestone(board, name, { agentId: 'coordinator', coordinatorActions: true, commit: git('rev-parse', 'main'), ...(next === undefined ? {} : { next }) });
  /** The roadmap document the roadmap command prints, one entry per milestone. */
  const document = () => milestoneRoadmap(project.repo, board, { ports: { ...store, roadmap, openBoard: openCellBoard, workQueue, listApiProjects } });
  /** The queue's own release order as the oracle, never a duplicate of its comparator. */
  const queueIds = () => {
    const queue = workQueue(board, { buildOrder: store.buildOrder, canTake: store.canTake, listItems: store.listItems, itemById: store.itemById, laneHold: store.laneHold,
      milestonePriorities: store.milestonePriorities, milestones: store.milestones, roadmap, ROUTES: store.ROUTES, foreignBlockers: store.foreignBlockers, localDependencyIds,
      dependencyLabel, itemFileCollisions, withLocalSeatPresence: store.withLocalSeatPresence, eligibilityProblem }, null, { policy: 'any', familyPolicy: 'off' });
    return [...queue.releases.flatMap(release => release.items), ...queue.unreleased].map(entry => entry.id);
  };
  /** The milestone moves recorded on an item's thread. */
  const moves = id => store.itemThread(board, id).filter(entry => entry.kind === 'milestone_moved');
  return { project, board, builder, git, item, add, members, ship, document, queueIds, moves };
}

/** The milestone named `name` in a roadmap document. */
function milestone(document, name) {
  return document.find((entry) => entry.name === name);
}

test('board.milestones.milestone-ships-what-landed-and-moves: [N26] a milestone ships what landed and moves the rest', (t) => {
  const box = fixture(t);
  const landed = box.item('Landed work', 'landed');
  const accepted = box.item('Accepted work', 'accepted');
  const open = box.item('Open work', 'open');
  const later = box.item('Later work', 'open');
  box.add('A', [landed, accepted, open]);
  box.add('B', [later]);

  // The target: set on A and shown in the roadmap and its JSON; a passed one is marked.
  const edited = editMilestone(box.board, 'A', { agentId: 'coordinator', target: store.canonicalMilestoneTarget('2026-01-02T03:04Z') });
  assert.equal(edited.target, '2026-01-02T03:04:00.000Z', 'the edit stores the target');
  const before = box.document();
  assert.equal(milestone(before, 'A').target, '2026-01-02T03:04:00.000Z', 'the roadmap JSON shows the target');
  assert.equal(milestone(before, 'A').pastTarget, true, 'an unshipped milestone past its target is marked');
  assert.equal(milestone(before, 'B').pastTarget, false, 'a milestone with no target is never past it');

  // Landed counting: only the merged item counts; each item shows landed, accepted or its status.
  assert.equal(milestone(before, 'A').landed, 1, 'only the item merged onto main counts as landed');
  assert.equal(milestone(before, 'A').done, 1, 'done means landed, so accepted work is not done');
  assert.equal(milestone(before, 'A').total, 3);
  assert.deepEqual(milestone(before, 'A').items.map(({ id, state }) => [id, state]),
    [[open, 'open'], [landed, 'landed'], [accepted, 'accepted']], 'each item shows its roadmap state, work to ship first');

  // Shipping is the coordinator's move, not a builder's.
  assert.throws(() => shipMilestone(box.board, 'A', { agentId: box.builder, commit: box.git('rev-parse', 'main') }),
    (error) => error.code === 'COORDINATOR_ONLY');

  // Ship: A records main's commit, and the two unlanded items move into B.
  const main = box.git('rev-parse', 'main');
  const shipped = box.ship('A');
  assert.equal(shipped.milestone.shipped.commit, main, "the milestone is shipped at main's commit");
  assert.equal(shipped.into, 'B', 'the next milestone is the one after it');
  assert.deepEqual(shipped.moved, [accepted, open]);
  assert.deepEqual(shipped.notMoved, [], 'no external references were left behind');
  const after = box.document();
  assert.equal(milestone(after, 'A').shipped.commit, main, "the roadmap shows main's commit on the shipped milestone");
  assert.deepEqual(milestone(after, 'A').items.map(({ id }) => id), [landed], 'only the landed item stays in the shipped milestone');
  assert.equal(milestone(after, 'A').pastTarget, false, 'a shipped milestone is no longer past its target');
  assert.deepEqual(store.milestones(box.board).find((entry) => entry.name === 'B').items, [later, accepted, open], 'the unlanded items are now in B, after its own');
  assert.deepEqual(milestone(after, 'B').items.map(({ id }) => id), [open, later, accepted], 'and the roadmap lists them work to ship first');

  // The threads: each moved item records the move; the landed one records none.
  for (const id of [accepted, open]) {
    const recorded = box.moves(id);
    assert.equal(recorded.length, 1, `#${id}'s thread records its move`);
    assert.equal(recorded[0].detail.from, 'A');
    assert.equal(recorded[0].detail.to, 'B');
    assert.equal(recorded[0].detail.commit, main);
  }
  assert.deepEqual(box.moves(landed), [], 'a landed item does not move');

  // The refusal: a shipped milestone takes no new items.
  assert.throws(() => box.members('A', { add: [String(later)] }), (error) => error.code === 'MILESTONE_SHIPPED', 'adding to a shipped milestone is refused');
  assert.deepEqual(milestone(box.document(), 'A').items.map(({ id }) => id), [landed], 'the refusal changes nothing');

  // A target means one instant on every replica: the move carries UTC, and a bare local time
  // in an ordered envelope is refused alike in every zone instead of read in each one's own.
  addMilestone(box.board, { agentId: 'coordinator', name: 'Z' });
  const snapshot = exportBoard(box.board);
  const prepared = prepareEngineMove(box.board, 'editMilestone', ['Z', { agentId: 'coordinator', target: '2026-10-20T18:00' }], { id: 'zone-target', actor: 'coordinator' });
  assert.match(prepared.args[1].target, /Z$/u, 'the prepared move carries the instant in UTC');
  const bare = { ...prepared, id: 'bare-target', args: ['Z', { agentId: 'coordinator', target: '2026-10-20T18:00' }] };
  const zone = process.env.TZ;
  const replicas = [];
  try {
    for (const name of ['UTC', 'America/Chicago']) {
      const replica = cellBoard(t, join(box.project.dir, `zone-${name.replace('/', '-')}.sqlite`), undefined, { real: true });
      importBoard(replica, snapshot);
      process.env.TZ = name;
      const refused = applyEngineMove(replica, bare, { sequence: 1, at: '2026-10-17T04:00:00.000Z' });
      assert.equal(refused.error?.code, 'MILESTONE_TARGET', `a bare local time is refused in ${name}: ${JSON.stringify(refused)}`);
      const applied = applyEngineMove(replica, prepared, { sequence: 2, at: '2026-10-17T04:00:01.000Z' });
      assert.equal(applied.error, undefined, JSON.stringify(applied));
      replicas.push(store.milestones(replica).find((row) => row.name === 'Z').target);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
  assert.equal(replicas[0], replicas[1], `every replica stores the same target: ${JSON.stringify(replicas)}`);
});

test('board.milestones.milestone-ship-next-names-where-the: [N26] milestone ship --next names where the unlanded items go', (t) => {
  const box = fixture(t);
  const open = box.item('Open work', 'open');
  box.add('A', [open]);
  box.add('B');
  box.add('C');
  const shipped = box.ship('A', 'C');
  assert.equal(shipped.into, 'C', '--next overrides the milestone after it');
  const document = box.document();
  assert.deepEqual(milestone(document, 'B').items, [], 'the milestone after it gets nothing');
  assert.deepEqual(milestone(document, 'C').items.map(({ id }) => id), [open], 'the --next milestone gets the unlanded item');
  assert.equal(box.moves(open)[0].detail.to, 'C', 'the thread names the --next milestone');
});

test('board.milestones.milestone-ship-leaves-external-references-place: [N26] milestone ship leaves external references in place and names them as not moved', (t) => {
  const box = fixture(t);
  box.add('JSON release', ['other-repo#17', 'third-repo#29']);
  const shipped = box.ship('JSON release');
  assert.deepEqual(shipped.notMoved, ['other-repo#17', 'third-repo#29'], 'the result lists each reference that remains on another board');
  assert.deepEqual(shipped.moved, [], 'shipping does not move foreign items');
  assert.deepEqual(milestone(box.document(), 'JSON release').items.map(({ id }) => id),
    ['other-repo#17', 'third-repo#29'], 'the foreign references remain on the shipped milestone');

  box.add('Text release', ['other-repo#31', 'third-repo#33']);
  assert.deepEqual(box.ship('Text release').notMoved, ['other-repo#31', 'third-repo#33'], 'every foreign reference that stayed in place is named');
});

test('board.milestones.engine-44-cannot-ship-milestone-set: [N26,H16] engine 44 cannot ship a milestone or set its target', (t) => {
  const box = fixture(t);
  box.add('A');
  box.add('B');
  const main = box.git('rev-parse', 'main');
  const moves = [
    prepareEngineMove(box.board, 'shipMilestone', ['A', { agentId: 'coordinator', commit: main, next: 'B' }],
      { id: 'engine44-milestone-ship', actor: 'coordinator' }),
    prepareEngineMove(box.board, 'editMilestone', ['A', { agentId: 'coordinator', target: '2026-10-20T18:00:00Z' }],
      { id: 'engine44-milestone-target', actor: 'coordinator' }),
  ];
  const before = exportBoard(box.board);

  for (const move of moves) {
    const oldEnvelope = { ...move, engine: 44 };
    assert.throws(() => applyEngineMove(box.board, oldEnvelope, { sequence: 1, at: '2026-10-17T12:00:00.000Z' }),
      (error) => error.code === 'RELAY_MOVE' && /introduced in engine 45/u.test(error.message),
      `${move.operation} was introduced in engine 45 and must not run as engine 44`);
    assert.deepEqual(exportBoard(box.board), before, 'an unsupported engine-44 meaning changes no rows or event history');
    assert.equal(appliedSequence(box.board), 0, 'pre-validation refusal does not advance the relay cursor');
    assert.equal(engineReceipt(box.board, move.id), null, 'pre-validation refusal creates no move receipt');
  }
});

/** Supported older clients can add before shipment, then obey the receiver's shipped state. */
test('board.milestones.older-engine-client-cannot-add-work: [N26,H16] an older-engine client cannot add work after a milestone ships', (t) => {
  const board = cellBoard(t, ':memory:');
  store.board_ensureCoordinator(board, '/milestone-legacy');
  const id = cellItem(board, { lane: 'core', title: 'Still owed', criterion: 'An obligation remains recorded', specIds: [] }).item_id;
  addMilestone(board, { agentId: 'coordinator', name: 'A', items: [] });
  addMilestone(board, { agentId: 'coordinator', name: 'B', items: [] });
  const sender = { kind: 'person', userId: 'milestone-fixture-user' };
  const before = prepareEngineMove(board, 'editMilestoneItems',
    ['B', { agentId: 'coordinator', add: [id], remove: [] }], { id: 'before38', actor: 'coordinator' });
  before.engine = 38;
  const added = applyRelayMove(board, before, { sequence: 1, at: '2026-10-18T01:00:00.000Z', sender, kind: 'move' });
  assert.equal(added.error, undefined, 'an engine38 addition to an unshipped milestone stays replayable');
  assert.deepEqual(store.milestones(board)[1].items, [id]);
  const ship = prepareEngineMove(board, 'shipMilestone',
    ['A', { agentId: 'coordinator', commit: '1'.repeat(40) }], { id: 'ship45', actor: 'coordinator' });
  assert.equal(ship.engine, ENGINE_VERSION, 'the current milestone writer is exercised');
  const shipped = applyRelayMove(board, ship, { sequence: 2, at: '2026-10-18T01:00:01.000Z', sender, kind: 'move' });
  assert.equal(shipped.error, undefined, JSON.stringify(shipped));
  assert.equal(store.milestones(board)[0].shipped.commit, '1'.repeat(40));
  const after = prepareEngineMove(board, 'editMilestoneItems',
    ['A', { agentId: 'coordinator', add: [id], remove: [] }], { id: 'after38', actor: 'coordinator' });
  after.engine = 38;
  const outcome = applyRelayMove(board, after, { sequence: 3, at: '2026-10-18T01:00:02.000Z', sender, kind: 'move' });
  assert.equal(outcome.error?.code, 'MILESTONE_SHIPPED', 'a supported older client cannot add work after shipment');
  assert.deepEqual(store.milestones(board)[0].items, [], 'refusal preserves the shipped milestone membership');
  assert.deepEqual(store.milestones(board)[1].items, [id], 'the legacy addition before shipment remains');
});

test('board.milestones.ordering-three-hundred-items-leads-both: [N22,B13] ordering three of a hundred items leads both queue and roadmap after named pins', t => {
  const box = fixture(t);
  const ids = Array.from({ length: 100 }, (_, n) => box.item('Ranked item ' + n, 'open'));
  box.add('hundred', ids);
  const chosen = [ids[92], ids[77], ids[89]];
  /** Order the milestone as the order command does and name the pins it preserved ahead of the order. */
  const order = () => {
    orderMilestoneItems(box.board, 'hundred', { agentId: 'coordinator', items: chosen.map(String), reason: SETUP });
    const entry = store.milestones(box.board).find(value => value.name === 'hundred');
    return (entry.order ?? []).filter(id => Object.hasOwn(entry.reasons ?? {}, String(id)));
  };
  /** Pin one item to the front, as the pin command does. */
  const pin = (id, reason) => orderMilestoneItems(box.board, 'hundred', { agentId: 'coordinator', items: [String(id)], place: 'pin', reason });
  assert.deepEqual(order(), []);
  assert.deepEqual(box.queueIds().slice(0, 3), chosen);
  assert.deepEqual(milestone(box.document(), 'hundred').items.map(item => item.id), box.queueIds());
  pin(ids[98], 'First real priority');
  assert.equal(box.queueIds()[0], ids[98], 'a new pin leads the existing explicit order');
  pin(ids[99], 'Newest urgent priority');
  assert.deepEqual(box.queueIds().slice(0, 2), [ids[99], ids[98]], 'a new pin leads prior pins too');
  assert.deepEqual(order(), [ids[99], ids[98]], 'the order names the preserved pins');
  const expected = [ids[99], ids[98], ...chosen];
  assert.deepEqual(box.queueIds().slice(0, expected.length), expected);
  assert.deepEqual(milestone(box.document(), 'hundred').items.map(item => item.id), box.queueIds());
  assert.equal(new Set(box.queueIds()).size, 100, 'ranking and pinning preserve every milestone member');
});

test('board.milestones.old-recorded-pin-moves-retain-append: [N22,B13] old recorded pin moves retain append semantics and current pins lead', t => {
  const box = fixture(t), ids = ['first', 'second', 'third'].map(title => box.item(title, 'open'));
  addMilestone(box.board, { agentId: 'coordinator', name: 'replay-pins', items: ids, reason: 'Fixture replay coverage' });
  box.board.executionEngineVersion = MILESTONE_QUEUE_ORDER_ENGINE - 1;
  for (const id of ids.slice(0, 2)) orderMilestoneItems(box.board, 'replay-pins', {
    agentId: 'coordinator', items: [id], place: 'pin', reason: 'Recorded old priority',
  });
  assert.deepEqual(store.milestones(box.board).find(item => item.name === 'replay-pins').order, ids.slice(0, 2));
  delete box.board.executionEngineVersion;
  orderMilestoneItems(box.board, 'replay-pins', { agentId: 'coordinator', items: [ids[2]], place: 'pin', reason: 'Current priority' });
  assert.deepEqual(store.milestones(box.board).find(item => item.name === 'replay-pins').order, [ids[2], ids[0], ids[1]]);
});
