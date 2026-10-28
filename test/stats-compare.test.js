/** Two hand-computed windows use real Git/SQLite history; current rows intentionally disagree [R1,R2,N2]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { exportBoard } from '../src/exchange.js';
import { importBoard } from '../src/exchange.js';
import { compareFlowWindows } from '../src/stats-flow.js';
import { comparisonLines } from '../src/stats-flow-window.js';
import { NEXT_IDLE_ENGINE } from '../src/next-idle-engine.js';
import { runFixtureGit } from './fixture-child.js';

const BASE = Date.parse('2026-10-10T00:00:00Z');
/** Exact minute offsets avoid timing margins in every expected interval. */
function at(minutes) { return new Date(BASE + minutes * 60_000).toISOString(); }
/** A native prospective observation identifies its allocated replay floor. */
function idle(reason) { return { version: 1, engine: NEXT_IDLE_ENGINE, reason }; }
/** Seed recorded transitions, retaining overlapping seats and a returned-to-open rework interval. */
function entries() {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  return [
    [0, 'coordinator', 'add', 1, { lane: 'core' }], [0, 'coordinator', 'add', 3, { lane: 'core' }],
    [0, 'core-1', 'claim', 1, { leaseUntil: at(200) }], [0, 'core-1', 'claim', 3, { leaseUntil: at(200) }],
    [0, 'review-1', 'next-idle', null, idle('review-family')],
    [10, 'core-1', 'submit', 3, { commit: a }], [15, 'core-1', 'submit', 1, { commit: a }],
    [15, 'core-1', 'next-idle', null, idle('held')],
    [20, 'review-1', 'reserve', 3, { until: at(200) }], [25, 'review-1', 'reject', 3, { commit: a }],
    [30, 'review-1', 'reserve', 1, { until: at(200) }],
    [40, 'core-1', 'claim', 3, { leaseUntil: at(200) }], [45, 'review-1', 'accept', 1, { commit: a }],
    [50, 'core-1', 'submit', 3, { commit: b }], [55, 'review-1', 'reserve', 3, { until: at(200) }],
    [58, 'review-1', 'accept', 3, { commit: b }], [59, 'coordinator', 'merged', 3],
    [60, 'coordinator', 'merged', 1],
    [60, 'coordinator', 'add', 2, { lane: 'core' }], [60, 'core-1', 'claim', 2, { leaseUntil: at(200) }],
    [60, 'review-1', 'next-idle', null, idle('main-red')],
    [75, 'core-1', 'submit', 2, { commit: a }], [75, 'core-1', 'next-idle', null, idle('nothing-eligible')],
    [90, 'review-1', 'reserve', 2, { until: at(200) }], [105, 'review-1', 'accept', 2, { commit: a }],
    [105, 'review-1', 'next-idle', null, idle('held')], [120, 'coordinator', 'merged', 2],
    ...[5, 20, 35, 60, 90].map(minute => [minute, 'core-1', 'shout', null, { to: 'coordinator' }]),
    [80, 'core-1', 'shout', null, { to: 'review-1' }],
  ];
}
/** Import only native event rows into a real private board, leaving all mutable item rows open. */
function fixture(t, changes = entries()) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-stats-compare-')));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { core: { owns: ['src/'] } } }));
  writeFileSync(join(root, 'PRACTICE.md'), '');
  const clock = { now: () => new Date(at(120)) };
  const seed = store.openBoard(join(root, '.git', 'seed.sqlite'), clock);
  store.register(seed, { lane: 'coordinator', path: root });
  store.register(seed, { lane: 'core', path: join(root, 'builder') });
  store.register(seed, { lane: 'review', path: join(root, 'reviewer') });
  for (let n = 1; n <= 3; n++) store.addItem(seed, { by: 'coordinator', lane: 'core', title: `Window ${n}` });
  const document = exportBoard(seed);
  store.closeBoard(seed);
  const joins = document.tables.agent.map(agent => [0, agent.agent_id, 'join', null, { lane: agent.agent_lane }]);
  document.tables.event = [...joins, ...changes].map((entry, order) => ({ entry, order }))
    .sort((a, b) => a.entry[0] - b.entry[0] || a.order - b.order)
    .map(({ entry: [minute, by, kind, id, detail = {}] }, index) => ({ event_id: index + 1,
      event_at: at(minute), event_by: by, event_kind: kind, item_id: id, event_detail: JSON.stringify(detail) }));
  document.tables.sqlite_sequence.find(row => row.name === 'event').seq = document.tables.event.length;
  const board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  importBoard(board, document);
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return { root, board, clock, history: () => store.events(board) };
}
/** Capture the actual CLI with its injected observation clock and full JSON protocol. */
async function cli(root, clock, args) {
  let stdout = '', stderr = '';
  const code = await main(args, { cwd: root, clock,
    stdout: { isTTY: false, write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr, data: args.includes('--json') ? JSON.parse(stdout) : null };
}

test('two adjacent event windows report every hand-computed figure and absolute change [R1,R2]', async t => {
  const box = fixture(t), before = box.history();
  const result = compareFlowWindows(before, { now: BASE + 120 * 60_000, windowMinutes: 60, complete: true });
  const previous = { since: at(0), until: at(60), landed: 2, observedSeats: 2, unmeasuredSeats: 0,
    agentHours: 2, idleHours: 72 / 60, idleShare: 72 / 120,
    idleReasonHours: { 'nothing-eligible': 0, held: 25 / 60, 'review-family': 20 / 60, 'main-red': 0, unknown: 27 / 60 },
    idleReasons: { 'nothing-eligible': 0, held: 25 / 120, 'review-family': 20 / 120, 'main-red': 0, unknown: 27 / 120 },
    agentHoursPerLanding: 1, stageHours: { build: 35 / 60, rework: 15 / 60, reviewWait: 30 / 60, review: 23 / 60, land: 16 / 60 },
    stageShares: { build: 35 / 119, rework: 15 / 119, reviewWait: 30 / 119, review: 23 / 119, land: 16 / 119 },
    unknownStageHours: 0, submissions: 3, submittedItems: 2, submitsPerItem: 1.5, rejections: 1,
    rejectRate: 1 / 3, coordinatorShouts: 4, shoutsPerLanding: 2 };
  const current = { since: at(60), until: at(120), landed: 1, observedSeats: 2, unmeasuredSeats: 0,
    agentHours: 2, idleHours: 90 / 60, idleShare: 90 / 120,
    idleReasonHours: { 'nothing-eligible': 45 / 60, held: 15 / 60, 'review-family': 0, 'main-red': 30 / 60, unknown: 0 },
    idleReasons: { 'nothing-eligible': 45 / 120, held: 15 / 120, 'review-family': 0, 'main-red': 30 / 120, unknown: 0 },
    agentHoursPerLanding: 2, stageHours: { build: 15 / 60, rework: 0, reviewWait: 15 / 60, review: 15 / 60, land: 15 / 60 },
    stageShares: { build: 1 / 4, rework: 0, reviewWait: 1 / 4, review: 1 / 4, land: 1 / 4 },
    unknownStageHours: 0, submissions: 1, submittedItems: 1, submitsPerItem: 1, rejections: 0,
    rejectRate: 0, coordinatorShouts: 1, shoutsPerLanding: 1 };
  assert.deepEqual(result.previous, previous);
  assert.deepEqual(result.current, current);
  /** These explicit expected windows are the hand calculation; every leaf delta must use the same units. */
  function differences(a, b) {
    return Object.fromEntries(Object.keys(a).filter(key => !['since', 'until'].includes(key)).map(key => [key,
      typeof a[key] === 'number' ? a[key] - b[key] : differences(a[key], b[key])]));
  }
  assert.deepEqual(result.change, differences(current, previous));
  assert.ok(store.listItems(box.board).every(row => row.item_status === 'open'), 'mutable rows intentionally contradict recorded landings');
  const json = await cli(box.root, box.clock, ['stats', '--window', '1h', '--compare', '--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(json.data.comparison, result);
  const text = await cli(box.root, box.clock, ['stats', '--window', '1h', '--compare']);
  assert.equal(text.code, 0, text.stderr);
  for (const line of comparisonLines(result)) assert.ok(text.stdout.includes(line), line);
  assert.deepEqual(box.history(), before, 'both formats are read-only and share the same event-only projection');
});

test('absent historical reasons stay unknown and incomplete windows never pretend measured zero [R2]', t => {
  const box = fixture(t, entries().filter(row => row[2] !== 'next-idle'));
  const result = compareFlowWindows(box.history(), { now: BASE + 120 * 60_000, windowMinutes: 60, complete: true });
  assert.equal(result.previous.idleReasons.unknown, 72 / 120);
  assert.equal(result.current.idleReasons.unknown, 90 / 120);
  for (const window of [result.current, result.previous]) {
    for (const reason of ['nothing-eligible', 'held', 'review-family', 'main-red']) assert.equal(window.idleReasons[reason], 0);
  }
  assert.equal(compareFlowWindows(box.history(), { now: BASE + 120 * 60_000, windowMinutes: 60 }).available, false);
  const empty = compareFlowWindows([], { now: BASE + 120 * 60_000, windowMinutes: 60, complete: true });
  for (const key of ['agentHoursPerLanding', 'rejectRate', 'submitsPerItem', 'shoutsPerLanding', 'idleShare']) assert.equal(empty.current[key], null, key);
});

test('next records an authenticated prospective cause and refuses an invented reason without an event [R2,N2]', t => {
  const box = fixture(t, []);
  const before = box.history().length;
  assert.deepEqual(store.recordNextIdle(box.board, { agentId: 'core-1', reason: 'held' }), { recorded: true });
  const event = box.history().at(-1);
  assert.equal(event.event_kind, 'next-idle');
  assert.equal(event.event_by, 'core-1');
  assert.deepEqual(JSON.parse(event.event_detail), idle('held'));
  assert.equal(box.history().length, before + 1);
  assert.throws(() => store.recordNextIdle(box.board, { agentId: 'core-1', reason: 'guessed-old-history' }), error => error.code === 'BAD_IDLE_REASON');
  assert.throws(() => store.recordNextIdle(box.board, { agentId: 'missing', reason: 'held' }), error => error.code === 'NOT_JOINED');
  assert.equal(box.history().length, before + 1);
  assert.deepEqual(store.recordNextIdle(box.board, { agentId: 'core-1', reason: 'held' }), { recorded: true, unchanged: true });
});


test('ordinary next records its structured observation but stats reads add no idle history [R2,N2]', async t => {
  const box = fixture(t, []);
  runFixtureGit(['add', '-A'], { cwd: box.root, stdio: 'pipe' });
  runFixtureGit(['-c', 'user.name=Stats fixture', '-c', 'user.email=stats@example.invalid', 'commit', '-qm', 'Seed private stats board'], { cwd: box.root, stdio: 'pipe' });
  const before = box.history();
  const result = await cli(box.root, box.clock, ['next', '--build', '--json']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.equal(result.data.error.code, 'NOTHING_FREE');
  const observed = box.history().filter(row => row.event_kind === 'next-idle');
  assert.equal(observed.length, 1, result.stdout + result.stderr);
  assert.equal(observed[0].event_by, 'coordinator');
  assert.deepEqual(JSON.parse(observed[0].event_detail), idle('nothing-eligible'));
  assert.deepEqual(box.history().filter(row => row.event_kind !== 'next-idle'), before);
  const after = box.history();
  const stats = await cli(box.root, box.clock, ['stats', '--window', '1h', '--compare', '--json']);
  assert.equal(stats.code, 0, stats.stderr);
  assert.deepEqual(box.history(), after);
});

test('next diagnostics preserve default query shapes and report only actually encountered held work [R2,N2]', t => {
  const box = fixture(t, []);
  const normal = store.nextFor(box.board, { agentId: 'core-1', lane: 'core' });
  assert.equal(normal.item.item_id, 1);
  assert.equal(Object.hasOwn(normal, 'idleReason'), false);
  store.holdLane(box.board, 'core', { agentId: 'coordinator', reason: 'explicit fixture hold' });
  const old = store.nextFor(box.board, { agentId: 'core-1', lane: 'core' });
  const observed = store.nextFor(box.board, { agentId: 'core-1', lane: 'core', observeIdle: true });
  assert.equal(observed.idleReason, 'held');
  const { idleReason: ignored, ...unchanged } = observed;
  assert.deepEqual(unchanged, old, 'observation does not change eligibility or historical return shape');
});
