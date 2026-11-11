/** A real Git/SQLite fixture proves coordinator counts, release refusal and durable person overrides [B35,R2,I15]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../index.js';
import * as store from '../../../packages/store/index.js';
import { coordinatorActions } from '../../../packages/stats/index.js';
import { coordinatorActionStats } from '../../../packages/stats/index.js';
import { coordinatorActionLines } from '../../../packages/stats/index.js';
import { checkCoordinatorRelease } from '../../../packages/gate/index.js';
import { recordCoordinatorRelease } from '../../../packages/gate/index.js';
import { readCoordinatorRelease } from '../../../packages/gate/index.js';
import { shipMilestone as rawShipMilestone } from '../../../packages/roadmap/index.js';
import { MOVE_REGISTRY } from '../../../packages/moves/index.js';
import { COORDINATOR_ACTIONS_ENGINE } from '../../../packages/state/index.js';
import { runReleaseGate } from '../../../packages/gate/index.js';
import { runFixtureGit } from '../../cli/tests/fixtures/child.js';

const BASE = Date.parse('2026-10-31T00:00:00Z');
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

/** Turn hand-computed minute offsets into canonical native event timestamps. */
function at(minute) { return new Date(BASE + minute * 60_000); }

/** Import explicit synthetic event history through the snapshot API, never by editing SQLite rows. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-coordinator-actions-'));
  const git = (...args) => runFixtureGit(args, { cwd: root });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'node -e "process.exit(99)"', lanes: { core: { owns: ['src/'], specs: ['G1'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Fixture\n- G1 [approved, must] Fixture. | gate: test\n');
  git('add', '-A');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'chore: fixture');
  const head = git('rev-parse', 'HEAD');
  const folder = join(root, '.git', 'pullboard');
  mkdirSync(folder, { recursive: true });
  const seed = openBoard(':memory:');
  store.register(seed, { lane: 'coordinator', path: root });
  store.register(seed, { lane: 'core', path: join(root, 'builder') });
  for (let n = 0; n < 3; n++) store.addItem(seed, { by: 'coordinator', lane: 'core', title: 'Fixture' });
  const document = store.exportBoard(seed);
  store.closeBoard(seed);
  const entries = [
    [-2880, 'coordinator', 'join', null, { lane: 'coordinator' }],
    [-2880, 'core-1', 'join', null, { lane: 'core' }],
    [1, 'coordinator', 'shout', null, { to: 'all', text: 'Progress' }],
    [2, 'coordinator', 'fact', 1, { id: 'note-1', kind: 'note', text: 'A note' }],
    [3, 'coordinator', 'milestone_items', null, { name: 'Release', items: [1, 2] }],
    [4, 'coordinator', 'merged', 1, { commit: head }],
    [5, 'coordinator', 'hold_item', 1, { reason: 'Fixture hold' }],
    [6, 'coordinator', 'unhold_item', 1, {}],
    [7, 'coordinator', 'reject_returned', 1, {}],
    [8, 'coordinator', 'fact', 1, { id: 'ruling-1', kind: 'decision', text: 'A ruling' }],
    [9, 'coordinator', 'line_setting', null, { key: 'focusMilestone', value: 'Release' }],
    [10, 'coordinator', 'merged', 2, { commit: head }],
    [11, 'coordinator', 'merged', 2, { commit: head }],
    [12, 'core-1', 'fact', 1, { id: 'builder-note', kind: 'note', text: 'Builder evidence' }],
  ];
  document.tables.event = entries.map(([minute, by, kind, item, detail], index) => ({
    event_id: index + 1, event_at: at(minute).toISOString(), event_by: by, event_kind: kind, item_id: item, event_detail: JSON.stringify(detail),
  }));
  document.tables.sqlite_sequence.find(row => row.name === 'event').seq = entries.length;
  // @pullboard-board-file journey: the real release gate reopens this imported private SQLite board to compare durable release history.
  const board = openBoard(join(folder, 'board.sqlite'), { now: () => at(60) });
  store.importBoard(board, document);
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return { root, board, head, folder };
}

/** A synthetic prior receipt file is only a fixture for the audit comparison, never proof of real release execution. */
function keepBaseline(f, id, report) {
  mkdirSync(join(f.folder, 'release-receipts'), { recursive: true });
  writeFileSync(join(f.folder, 'release-receipts', `${id}.json`), '{"synthetic":true}\n');
  return recordCoordinatorRelease(f.root, id, f.head, report, at(60));
}

test('coordinator actions name the window, distinct landing population and every kind [B35,R2]', t => {
  const f = fixture(t);
  const report = coordinatorActions(f.board, { since: at(0).toISOString(), until: at(60).toISOString() });
  assert.equal(report.actions, 11);
  assert.equal(report.landed, 2);
  assert.deepEqual(report.landedItems, [1, 2]);
  assert.equal(report.perLanding, 5.5);
  assert.deepEqual(Object.fromEntries(Object.entries(report.byKind).map(([key, row]) => [key, row.count])),
    { shout: 1, fact: 1, placement: 1, landing: 3, holdOrRelease: 2, rejectReturn: 1, ruling: 1, other: 1 });
  assert.match(coordinatorActionLines(report).join('\n'), /2026-10-31T00:00:00.000Z.*2026-10-31T01:00:00.000Z/u);
  const decision = { event_at: at(20).toISOString(), event_by: 'coordinator', event_kind: 'shout', item_id: null, event_detail: '{\"decision\":true}' };
  const answer = { ...decision, event_kind: 'answer', event_detail: '{\"answers\":1}' };
  const decided = coordinatorActionStats([...store.events(f.board), decision, answer], { since: at(0).toISOString(), until: at(60).toISOString() });
  assert.equal(decided.byKind.ruling.count, 2, 'an answer is a ruling; a decision request is a shout');
  assert.equal(decided.byKind.shout.count, 2);
  const history = store.events(f.board);
  history.push({ event_at: at(-1).toISOString(), event_by: 'coordinator', event_kind: 'merged', item_id: 1, event_detail: '{}' });
  assert.deepEqual(coordinatorActionStats(history, { since: at(0).toISOString(), until: at(60).toISOString() }).landedItems, [2],
    'a repeat receipt does not turn an earlier landing into a new one');
});

test('a release with a higher coordinator rate is refused before its gate, naming the kind; a person override is recorded [B35,R2,I15]', async t => {
  const f = fixture(t);
  keepBaseline(f, FIRST, checkCoordinatorRelease(f.root, { now: at(60) }));
  store.shout(f.board, { from: 'coordinator', to: 'all', text: 'Another manual nudge', lanes: ['core'] });
  assert.throws(() => checkCoordinatorRelease(f.root, { now: at(60) }), error => error.code === 'GATE_RUN_EVIDENCE' && /rose.*shout/u.test(error.message));
  // Actual release entry point must refuse before asking for executors or running the deliberately red gate.
  await assert.rejects(runReleaseGate(f.root), error => error.code === 'GATE_RUN_EVIDENCE' && /coordinator actions/u.test(error.message));
  assert.throws(() => checkCoordinatorRelease(f.root, { now: at(60), personOverride: ' ' }), /nonempty reason/u);
  const report = checkCoordinatorRelease(f.root, { now: at(60), personOverride: 'Person approved the one-time migration.' });
  assert.match(report.problem, /shout/u);
  keepBaseline(f, SECOND, report);
  assert.deepEqual(readCoordinatorRelease(f.root, SECOND).override, { by: 'person', reason: 'Person approved the one-time migration.' });
  assert.equal(readCoordinatorRelease(f.root, SECOND).previous, FIRST);
  assert.equal(readCoordinatorRelease(f.root, SECOND).sequence, 2);
  assert.doesNotThrow(() => checkCoordinatorRelease(f.root, { now: at(60) }), 'the latest override becomes the previous release even when both audit clocks tie');
});

test('zero landings never invent a rate or erase the previous measured release [B35,R2,I15]', t => {
  const f = fixture(t);
  keepBaseline(f, FIRST, checkCoordinatorRelease(f.root, { now: at(60) }));
  assert.throws(() => checkCoordinatorRelease(f.root, { now: at(3000) }), /unmeasured.*no items landed/u);
  const report = checkCoordinatorRelease(f.root, { now: at(3000), personOverride: 'Person approved a maintenance-only release.' });
  assert.equal(report.gauge.perLanding, null);
  keepBaseline(f, SECOND, report);
  assert.throws(() => checkCoordinatorRelease(f.root, { now: at(3001) }), /unmeasured/u);
});


test('a builder worktree cannot declare the person release override [B35,R2,I15]', t => {
  const f = fixture(t);
  const worker = join(f.root, 'worker');
  runFixtureGit(['worktree', 'add', '--detach', worker, 'HEAD'], { cwd: f.root });
  assert.throws(() => checkCoordinatorRelease(worker, { now: at(60), personOverride: 'Agent attempting an override.' }), /person.*primary checkout/u);
});

test('project milestone shipping enforces and records the ratchet in the shared board log [B35,R2,I15]', t => {
  const f = fixture(t);
  keepBaseline(f, FIRST, checkCoordinatorRelease(f.root, { now: at(60) }));
  assert.equal(MOVE_REGISTRY.shipMilestone.minimumEngine(['First release', { coordinatorActions: true }], f.board), COORDINATOR_ACTIONS_ENGINE);
  assert.equal(MOVE_REGISTRY.shipMilestone.minimumEngine(['First release', {}], f.board), COORDINATOR_ACTIONS_ENGINE, 'fresh native API captures use the new floor too');
  store.addMilestone(f.board, { agentId: 'coordinator', name: 'First release', items: [] });
  store.addMilestone(f.board, { agentId: 'coordinator', name: 'Next release', items: [] });
  store.shipMilestone(f.board, 'First release', { agentId: 'coordinator', commit: f.head });
  assert.equal(MOVE_REGISTRY.shipMilestone.minimumEngine(['Next release', {}], f.board), COORDINATOR_ACTIONS_ENGINE, 'an activated project cannot fall back to an unmarked older ship');
  store.shout(f.board, { from: 'coordinator', to: 'all', text: 'Another mechanical nudge', lanes: ['core'] });
  assert.throws(() => store.shipMilestone(f.board, 'Next release', { agentId: 'coordinator', commit: f.head }),
    error => error.code === 'COORDINATOR_ACTIONS_ROSE' && /shout/u.test(error.message));
  assert.equal(Boolean(store.milestones(f.board).find(entry => entry.name === 'Next release').shipped), false, 'a refusal leaves the release unshipped');
  store.shipMilestone(f.board, 'Next release', { agentId: 'coordinator', commit: f.head, asPerson: true, reason: 'Person approved this migration.', channel: 'terminal' });
  const event = store.events(f.board).findLast(entry => entry.event_kind === 'milestone_ship');
  const audit = JSON.parse(event.event_detail).coordinatorActions;
  assert.deepEqual(audit.override, { by: 'person', reason: 'Person approved this migration.', channel: 'terminal' });
  assert.equal(audit.previous, 'First release');
  assert.equal(audit.gauge.actions, coordinatorActions(f.board).actions, 'the recorded baseline includes the release move itself');
  assert.doesNotThrow(() => checkCoordinatorRelease(f.root, { now: at(60) }), 'the newer shared project release supersedes an older, lower host-local audit');
  store.shout(f.board, { from: 'coordinator', to: 'all', text: 'A later manual nudge', lanes: ['core'] });
  assert.throws(() => checkCoordinatorRelease(f.root, { now: at(60) }), /rose.*shout/u,
    'the native full-gate path also sees the project release baseline without any host audit files');
});


test('release override validation takes its ports before reading the board [B35,C7]', () => {
  const board = new Proxy({}, { get() { throw new Error('board touched before ports'); } });
  assert.throws(() => rawShipMilestone(board, 'Release', { agentId: 'coordinator', commit: 'a'.repeat(40), asPerson: true, reason: 'Person reason.' }, {}), TypeError);
});
