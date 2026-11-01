/** A real Git/SQLite fixture proves coordinator counts, release refusal and durable person overrides [B35,R2,I15]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../src/native-board.js';
import * as store from '../../store/index.js';
import { coordinatorActions } from '../index.js';
import { coordinatorActionStats } from '../index.js';
import { coordinatorActionLines } from '../index.js';
import { checkCoordinatorRelease } from '../../gate/index.js';
import { recordCoordinatorRelease } from '../../gate/index.js';
import { readCoordinatorRelease } from '../../gate/index.js';
import { runReleaseGate } from '../../gate/index.js';
import { runFixtureGit } from '../../../test/fixture-child.js';

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
  const seed = openBoard(join(folder, 'seed.sqlite'));
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
