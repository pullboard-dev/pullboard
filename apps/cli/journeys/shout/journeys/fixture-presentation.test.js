/** @pullboard-test-gui */
/** @pullboard-test-input source-cell apps/cli apps/lib store */
/** Cockpit fixture opt-out, borrowed presentation and observation ages [N26,H16,A10]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  addItem,
  closeBoard,
} from '../../../../../packages/store/index.js';
import {
  openBoard,
} from '../../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../../packages/store/index.js';
import {
  projectState,
} from '../../../src/io/view.js';
import {
  scratch,
  machine,
  project,
  assertObservationsEqual,
} from '../../../tests/fixtures/cockpit/harness.js';

test('the view fixture opts out of the background view [N26]', () => {
  const box = machine();
  const originalHome = box.env.PULLBOARD_MACHINE_HOME;
  const originalFile = join(originalHome, 'settings.json');
  assert.equal(JSON.parse(readFileSync(originalFile, 'utf8')).view.background, false,
    'machine setup opts out before any CLI command runs');

  // A second machine in the same scratch root can override the effective home after machine().
  // Seed unrelated settings there to prove project() preserves them when it applies the opt-out.
  const overrideHome = join(box.dir, 'second-machine-home');
  mkdirSync(overrideHome);
  const overrideFile = join(overrideHome, 'settings.json');
  writeFileSync(overrideFile, JSON.stringify({ browserSlots: 1, view: { custom: 'keep', background: true } }));
  box.env.PULLBOARD_MACHINE_HOME = overrideHome;
  let checkedInit = false;
  const realRun = box.runWithEnv;
  /** Observe the real init boundary before delegating to the unchanged fixture CLI runner. */
  box.runWithEnv = (cwd, env, ...args) => {
    if (args[0] === 'init') {
      checkedInit = true;
      assert.equal(env.PULLBOARD_MACHINE_HOME, overrideHome, 'check the exact environment passed to init');
      assert.deepEqual(JSON.parse(readFileSync(join(env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')),
        { browserSlots: 1, view: { custom: 'keep', background: false } },
        'the effective machine opts out before the real init, without replacing its other settings');
    }
    return realRun(cwd, env, ...args);
  };
  project(box, 'background-view-opt-out');
  assert.equal(checkedInit, true, 'the fixture executes the actual init command');
  assert.equal(JSON.parse(readFileSync(originalFile, 'utf8')).view.background, false,
    'changing the effective home leaves the first private machine alone');
  assert.equal(JSON.parse(readFileSync(overrideFile, 'utf8')).view.background, false,
    'later copied or hooked CLI commands retain the effective machine opt-out');
});

test('clause 1: borrowed board presentation keeps parity, shows staged rows, and leaves the caller connection open [N26,H16]', async () => {
  const box = machine();
  const p = project(box, 'projector');
  await box.runIn(p.repo, 'add', 'web', 'Existing projection row', '--criterion', 'same native data');
  // @pullboard-board-file journey: opens the project board file read-only to compare its presentation with a staged copy.
  const source = openBoard(join(p.repo, '.git', 'pullboard', 'board.sqlite'));
  const staged = openBoard(':memory:');
  try {
    importBoard(staged, exportBoard(source));
    const ordinary = projectState(p.repo);
    assert.ok(ordinary.agents.every(agent => agent.presence === 'live' && typeof agent.heartbeatAt === 'string'),
      'real native fixture heartbeats remain visible beside the durable board');
    const borrowed = projectState(p.repo, { board: staged });
    // The dashboard's four-hour window ends at each read's own clock, so the two reads differ by milliseconds; its counts must not.
    const sameWindow = state => ({ ...state, dashboardRecent: { ...state.dashboardRecent, since: 0, until: 0 } });
    assert.deepEqual(sameWindow(borrowed), sameWindow({ ...ordinary, agents: ordinary.agents.map(agent => ({ ...agent, heartbeatAt: null, presence: 'gone' })) }),
      'borrowed projection preserves every durable field; an in-memory import has no native presence sidecar');
    const before = exportBoard(source);
    const stagedId = addItem(staged, { by: 'coordinator', lane: 'web', title: 'Staged recovery row', criterion: 'visible only in staged snapshot' });
    const stagedState = projectState(p.repo, { board: staged });
    assert.ok(stagedState.items.some(item => item.id === stagedId && item.title === 'Staged recovery row'));
    assert.ok(!projectState(p.repo).items.some(item => item.title === 'Staged recovery row'), 'staged-only rows never change the native board');
    assert.deepEqual(exportBoard(source), before, 'projection from the staged connection does not mutate source rows');
    assert.equal(staged.db.prepare('SELECT 1 AS open').get().open, 1, 'the caller-owned staged connection stays open');
  } finally {
    closeBoard(staged);
    closeBoard(source);
  }
});

test('observation-time ages compare by their own clock [A10]', () => {
  const since = '2026-10-10T09:00:00.000Z';
  const firstAsOf = '2026-10-10T10:00:00.000Z';
  const secondAsOf = '2026-10-10T10:00:00.129Z';
  /** Build one synthetic board observation at the supplied capture time. */
  const snapshot = asOf => ({
    observedAt: asOf,
    board: { id: 'same-board', event: { event_id: 42 } },
    proofStats: {
      flow: {
        asOf,
        total: 3,
        queues: {
          open: {
            count: 1,
            oldest: { id: 7, since, ageMinutes: (Date.parse(asOf) - Date.parse(since)) / 60000 },
          },
        },
      },
      other: { asOf: 'unchanged-time', ageMinutes: 3 },
    },
  });
  const first = snapshot(firstAsOf);
  const second = snapshot(secondAsOf);
  assertObservationsEqual(first, second, '129ms-separated observations match after validating their own ages');

  const wrongClock = { ...second, observedAt: 'not a timestamp' };
  assert.throws(() => assertObservationsEqual(first, wrongClock, 'invalid read clock must be rejected'), error => error.code === 'ERR_ASSERTION' && /observedAt/u.test(error.message));
  const nestedClock = structuredClone(second);
  nestedClock.board.observedAt = secondAsOf;
  assert.throws(() => assertObservationsEqual(first, nestedClock, 'nested observedAt remains invariant'), error => error.code === 'ERR_ASSERTION');

  const wrongAge = structuredClone(second);
  wrongAge.proofStats.flow.queues.open.oldest.ageMinutes += 1;
  assert.throws(() => assertObservationsEqual(first, wrongAge, 'wrong age must be rejected'), error => error.code === 'ERR_ASSERTION' && /ageMinutes/u.test(error.message));

  const changedSince = structuredClone(second);
  changedSince.proofStats.flow.queues.open.oldest.since = '2026-10-10T08:59:59.000Z';
  changedSince.proofStats.flow.queues.open.oldest.ageMinutes = (Date.parse(secondAsOf) - Date.parse(changedSince.proofStats.flow.queues.open.oldest.since)) / 60000;
  assert.throws(() => assertObservationsEqual(first, changedSince, 'different since must be rejected'), error => error.code === 'ERR_ASSERTION');

  const changedInvariant = structuredClone(second);
  changedInvariant.proofStats.other.ageMinutes += 1;
  assert.throws(() => assertObservationsEqual(first, changedInvariant, 'unrelated ageMinutes must be retained'), error => error.code === 'ERR_ASSERTION');
});
