/** Hand-computed flow reporting uses real Git/SQLite and immutable native history [R1,R2]. */
import { events as readStatsEvents } from '../../../../packages/store/index.js';
import { counterProofStats as readStatsCounter } from '../../../../packages/verify/index.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { proofStats } from '../../../../packages/stats/index.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';

/** Native read operations explicitly supplied to the statistics under test. */
const statsReadPorts = { events: readStatsEvents, counterProofStats: readStatsCounter };


const BASE = Date.parse('2026-10-10T00:00:00Z');

/** Convert fixture minutes into exact UTC timestamps. */
function at(minutes) { return new Date(BASE + minutes * 60_000).toISOString(); }

/** Construct a captured submission size without inferring old history from today's Git tree. */
function submission(id, lines) {
  const head = id.toString(16).padStart(40, '0');
  return { commit: head, ...(lines === null ? {} : {
    submissionSize: { base: 'a'.repeat(40), head, lines, method: 'added-plus-deleted-no-renames' },
  }) };
}

/** Import immutable event history; deliberately stale current item rows cannot supply its answers. */
function fixture(t, entries) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-flow-report-'));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  const seed = openBoard(join(root, '.git', 'seed.sqlite'));
  store.register(seed, { lane: 'coordinator', path: root });
  store.register(seed, { lane: 'core', path: join(root, 'builder') });
  store.register(seed, { lane: 'review', path: join(root, 'reviewer') });
  for (let id = 1; id <= 8; id += 1) {
    store.addItem(seed, { by: 'coordinator', lane: 'core', title: `Report ${id}` });
  }
  const document = exportBoard(seed);
  store.closeBoard(seed);
  const joins = document.tables.agent.map(agent => [0, agent.agent_id, 'join', null, { lane: agent.agent_lane }]);
  document.tables.event = [...joins, ...entries].map((entry, order) => ({ entry, order }))
    .sort((a, b) => a.entry[0] - b.entry[0] || a.order - b.order)
    .map(({ entry: [minutes, by, kind, item, detail = {}] }, index) => ({
      event_id: index + 1, event_at: at(minutes), event_by: by, event_kind: kind,
      item_id: item, event_detail: JSON.stringify(detail),
    }));
  document.tables.sqlite_sequence.find(row => row.name === 'event').seq = document.tables.event.length;
  const board = openBoard(join(root, '.git', 'flow.sqlite'));
  importBoard(board, document);
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return board;
}

/** A single known first attempt supplies exact size-edge controls. */
function simple(id, lines) {
  const submitted = submission(id, lines);
  return [
    [0, 'coordinator', 'add', id, { lane: 'core' }],
    [1, 'core-1', 'claim', id, { leaseUntil: at(200) }],
    [2, 'core-1', 'submit', id, submitted],
    [3, 'review-1', 'reserve', id, { until: at(200) }],
    [4, 'review-1', 'accept', id, { commit: submitted.commit }],
    [5, 'coordinator', 'merged', id],
  ];
}

/** The first-try denominator excludes genuinely unknown first decisions. */
function firstTry(accepted, decided, unknown = 0) {
  return { accepted, decided, rate: decided ? accepted / decided : null, unknown };
}

test('lib.flow-report.the-flow-report-splits-time-into: the flow report splits time into waiting for an agent, building, review, landing and rework [R1,R2]', t => {
  const first = submission(101, 99), second = submission(102, 900);
  const board = fixture(t, [
    [0, 'coordinator', 'add', 1, { lane: 'core', after: [2] }],
    [0, 'coordinator', 'add', 2, { lane: 'core' }],
    [0, 'coordinator', 'milestone_add', null, { name: 'Release', items: [1, 2] }],
    [0, 'coordinator', 'milestone_add', null, { name: 'Later', items: [3] }],
    [0, 'coordinator', 'line_setting', null, { key: 'focusMilestone', value: 'Release', reason: 'Current release' }],
    [115, 'coordinator', 'line_setting', null, { key: 'focusMilestone', value: 'Later', reason: 'Next release' }],
    [0, 'core-1', 'claim', 2, { leaseUntil: at(200) }],
    [2, 'core-1', 'submit', 2, submission(2, 100)],
    [3, 'review-1', 'reserve', 2, { until: at(200) }],
    [4, 'review-1', 'accept', 2, { commit: submission(2, 100).commit }],
    [10, 'coordinator', 'merged', 2],
    [12, 'coordinator', 'hold_item', 1, { reason: 'Needs a decision' }],
    [17, 'coordinator', 'unhold_item', 1, { reason: 'Decision recorded' }],
    [20, 'core-1', 'claim', 1, { leaseUntil: at(200) }],
    [30, 'core-1', 'submit', 1, first],
    [35, 'review-1', 'reserve', 1, { until: at(40) }],
    [45, 'review-1', 'reserve', 1, { until: at(200) }],
    [50, 'review-1', 'release', 1, { review: true }],
    [55, 'review-1', 'reserve', 1, { until: at(200) }],
    [60, 'review-1', 'reject', 1, { commit: first.commit }],
    [70, 'core-1', 'claim', 1, { leaseUntil: at(200) }],
    [80, 'core-1', 'submit', 1, second],
    [85, 'review-1', 'reserve', 1, { until: at(200) }],
    [90, 'review-1', 'accept', 1, { commit: second.commit }],
    [100, 'coordinator', 'merged', 1],
    ...simple(3, 299).map(([minute, ...entry]) => [minute === 0 ? 110 : minute + 119, ...entry]),
    ...simple(4, 300), ...simple(5, 799), ...simple(6, 800),
    ...simple(7, null),
    // A legacy landing with no original add/claim/submission/verdict cannot acquire fabricated zeroes.
    [100, 'coordinator', 'merged', 8],
  ]);
  const history = store.events(board);
  const report = proofStats(board, { now: BASE + 130 * 60_000 }, statsReadPorts).flow.report;
  assert.ok(report, 'the canonical observer exposes the requested report');
  const item = report.items.find(row => row.id === 1);
  assert.equal(item.lane, 'core');
  assert.equal(item.milestone, 'Release', 'group by latest recorded milestone membership, not mutable item rows');
  assert.deepEqual(item.stages, {
    ready: { minutes: 11, unknown: 0 }, // Dependency accepted at 4: 4-12 and 17-20.
    later: { minutes: 9, unknown: 0 }, // Dependency 0-4 and explicit hold 12-17.
    build: { minutes: 20, unknown: 0 }, // Both active claims, including the repair claim.
    reviewWait: { minutes: 20, unknown: 0 }, // 30-35, 40-45, 50-55, 80-85.
    review: { minutes: 20, unknown: 0 }, // 35-40, 45-50, 55-60, 85-90.
    mergeWait: { minutes: 10, unknown: 0 },
    rework: { minutes: 10, unknown: 0 }, // Reject-to-next-claim gap, 60-70; active repair is build.
  });
  const filedLater = report.items.find(row => row.id === 3);
  assert.deepEqual(filedLater.stages.later, { minutes: 5, unknown: 0 }, '110-115 is filed outside the recorded current milestone');
  assert.deepEqual(filedLater.stages.ready, { minutes: 5, unknown: 0 }, '115-120 waits in the newly focused milestone');
  assert.equal(report.items.find(row => row.id === 4).stages.build.minutes, 1, 'focus preference never invalidates an actual recorded claim outside the focus');
  assert.deepEqual(item.firstTry, firstTry(0, 1));
  assert.equal(item.submissionsPerLanded, 2);
  assert.deepEqual(item.sizeBuckets.under100, firstTry(0, 1), 'use first submission size, not its larger replacement');
  const unknown = report.items.find(row => row.id === 8);
  assert.equal(unknown.stages.build.minutes, null);
  assert.equal(unknown.stages.build.unknown, 1);
  assert.deepEqual(unknown.firstTry, firstTry(0, 0, 1));
  assert.equal(unknown.submissionsPerLanded, null);
  assert.deepEqual(report.overall.firstTry, firstTry(6, 7, 1));
  assert.equal(report.overall.submissionsPerLanded, null, 'an unknown historical submission count prevents a fabricated overall ratio');
  assert.deepEqual(report.overall.sizeBuckets, {
    under100: firstTry(0, 1), '100to300': firstTry(2, 2),
    '300to800': firstTry(2, 2), '800plus': firstTry(1, 1), unknown: firstTry(1, 1, 1),
  });
  assert.deepEqual(report.lanes.find(row => row.lane === 'core').firstTry, firstTry(6, 7, 0));
  const milestone = report.milestones.find(row => row.milestone === 'Release');
  assert.deepEqual(milestone.firstTry, firstTry(1, 2));
  assert.equal(milestone.submissionsPerLanded, 1.5);
  assert.deepEqual(store.events(board), history, 'reading the report writes no inferred history');
});
