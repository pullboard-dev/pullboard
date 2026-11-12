/** Report capability migration preserves existing indexed read-only statistics [R1,R2]. */
import { events as readStatsEvents } from '../../../../../packages/store/index.js';
import { counterProofStats as readStatsCounter } from '../../../../../packages/verify/index.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../index.js';
import { addMilestone } from '../../../../../packages/store/index.js';
import { editMilestoneItems } from '../../../../../packages/store/index.js';
import { editMilestone } from '../../../../../packages/store/index.js';
import { shipMilestone } from '../../../../../packages/store/index.js';
import { removeMilestone } from '../../../../../packages/store/index.js';
import { orderMilestoneItems } from '../../../../../packages/store/index.js';
import { proofStats } from '../../../../../packages/stats/index.js';
import { flowStats } from '../../../../../packages/stats/index.js';
import { FLOW_REPORT_VERSION } from '../../../../../packages/stats/index.js';
import { ensureProofCounters } from '../../../../../packages/verify/index.js';
import { runFixtureGit } from '../../../../cli/tests/fixtures/child.js';
import { submitFixture } from '../../../../cli/tests/fixtures/board/submit.js';
import { repositoryBoardFile } from '../../../../cli/tests/fixtures/board/submit.js';
import { MILESTONE_PLACEMENT_ENGINE } from '../../../../../packages/state/light.js';

/** Native read operations explicitly supplied to the statistics under test. */
const statsReadPorts = { events: readStatsEvents, counterProofStats: readStatsCounter };


/** Construct a native board whose append path maintains current report shards. */
function fixture(t, { item = true, now } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-report-cache-'));
  // The board sits where the native CLI keeps it, inside a repository with committed policy, so submit can seal it.
  // @pullboard-board-file journey: the board sits where the native CLI keeps it so submit can seal it
  const board = openBoard(repositoryBoardFile(root), now ? { now } : undefined);
  store.register(board, { lane: 'coordinator', path: root });
  if (item) store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Known open history' });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return board;
}

test('an empty indexed board has a measured empty report rather than a missing capability [R1,R2]', t => {
  const board = fixture(t, { item: false });
  const report = proofStats(board, {}, statsReadPorts).flow.report;
  assert.deepEqual(report.items, []);
  assert.deepEqual(report.lanes, []);
  assert.deepEqual(report.milestones, []);
  assert.deepEqual(report.overall.firstTry, { accepted: 0, decided: 0, rate: null, unknown: 0 });
  assert.equal(report.overall.submissionsPerLanded, null);
});

test('flow report indexed projection matches canonical replay without hot raw history reads [R1,R2]', t => {
  const board = fixture(t);
  const now = Date.now() + 60_000;
  const history = store.events(board);
  const stats = proofStats(board, { now }, statsReadPorts);
  assert.deepEqual(stats.flow.report, flowStats(history, null, now, stats).report);
  const prepare = board.db.prepare.bind(board.db);
  const reads = [];
  board.db.prepare = sql => { reads.push(sql); return prepare(sql); };
  t.after(() => { board.db.prepare = prepare; });
  assert.deepEqual(proofStats(board, { now }, statsReadPorts).flow.report, stats.flow.report);
  assert.ok(!reads.some(sql => /SELECT\s+\*\s+FROM\s+event\b/i.test(sql)), 'current report reads indexed facts, never raw event history');
  assert.equal(proofStats(board, { now, since: '2026-10-01' }, statsReadPorts).flow.report.scope, 'all-time', 'a date-filtered legacy summary visibly labels the report scope');
});

test('old v2 counters retain fast metrics and explicitly unavailable reports until a writer rebuilds [R1,R2]', t => {
  const board = fixture(t);
  board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run('local:proof-stats:v2:report-summary');
  const prepare = board.db.prepare.bind(board.db);
  const reads = [];
  board.db.prepare = sql => { reads.push(sql); return prepare(sql); };
  const old = proofStats(board, {}, statsReadPorts);
  assert.deepEqual(old.flow.report, { available: false });
  assert.equal(old.flow.queues.open.size, 1);
  assert.ok(!reads.some(sql => /SELECT\s+\*\s+FROM\s+event\b/i.test(sql)), 'missing optional report capability does not force raw fallback');
  board.db.prepare = prepare;
  const before = store.events(board);
  ensureProofCounters(board);
  assert.ok(proofStats(board, {}, statsReadPorts).flow.report.items);
  assert.deepEqual(store.events(board), before, 'writer backfill changes only local derived counters');
});

test('an older writer cannot make retained report capability look current [R1,R2,H16]', t => {
  const board = fixture(t);
  const reportKeys = 'local:proof-stats:v2:report-*';
  const retained = board.db.prepare('SELECT meta_key,meta_value FROM board_meta WHERE meta_key GLOB ?').all(reportKeys);
  const previousEvents = store.events(board);
  store.addItem(board, { by: 'coordinator', lane: 'api', title: 'An older writer advances native history' });
  // Emulate an older writer's exact derived-state boundary: ordinary counters advance; report shards do not.
  board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(reportKeys);
  for (const row of retained) board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(row.meta_key, row.meta_value);
  const stale = proofStats(board, {}, statsReadPorts);
  assert.equal(stale.flow.queues.open.size, 2, 'existing native counters remain usable');
  assert.deepEqual(stale.flow.report, { available: false }, 'retained version alone cannot certify intervening older-writer events');
  const before = store.events(board);
  const proofEvents = [], reportEvents = [];
  board.onProofStatsEvent = event => proofEvents.push(event.event_id);
  board.onFlowReportEvent = event => reportEvents.push(event.event_id);
  ensureProofCounters(board);
  assert.equal(proofStats(board, {}, statsReadPorts).flow.report.items.length, 2);
  assert.deepEqual(proofEvents, [], 'report catch-up never rebuilds or recounts the existing proof statistics');
  assert.deepEqual(reportEvents, before.slice(previousEvents.length).map(event => event.event_id),
    'only the missed native events are folded into the report');
  assert.deepEqual(store.events(board), before, 'repair changes derived counters only');
});

test('retained refreezes keep active build time and prototype-like recorded names remain ordinary groups [R1,R2]', () => {
  const base = Date.parse('2026-10-10T00:00:00Z');
  const commit = 'a'.repeat(40);
  const entries = [
    [0, 'milestone_add', null, { name: '__proto__', items: [1] }],
    [0, 'line_setting', null, { key: 'focusMilestone', value: '__proto__' }],
    [0, 'add', 1, { lane: '__proto__' }],
    [10, 'claim', 1, { leaseUntil: new Date(base + 100 * 60_000).toISOString() }],
    [15, 'refreeze', 1, { retainedClaim: true }],
    [30, 'submit', 1, { commit }],
  ];
  const history = entries.map(([minute, kind, item, detail], index) => ({ event_id: index + 1,
    event_at: new Date(base + minute * 60_000).toISOString(), event_by: 'core-1',
    event_kind: kind, item_id: item, event_detail: JSON.stringify(detail) }));
  const counts = { submissions: 1, rejections: 0, rejectionShare: 0 };
  const during = flowStats(history.slice(0, -1), null, base + 20 * 60_000, counts);
  assert.equal(during.queues.claimed.size, 1, 'a retained native refreeze leaves the same live claim in place');
  const report = flowStats(history, null, base + 30 * 60_000, counts).report;
  assert.deepEqual(report.items[0].stages.build, { minutes: 20, unknown: 0 });
  assert.deepEqual(report.items[0].stages.rework, { minutes: 0, unknown: 0 });
  assert.equal(report.lanes[0].lane, '__proto__');
  assert.equal(report.milestones[0].milestone, '__proto__');
});


test('an item fact after claim expiry cannot reclassify the preceding active build [R1,R2]', () => {
  const base = Date.parse('2026-10-10T00:00:00Z');
  const entries = [
    [0, 'add', { lane: 'core' }],
    [10, 'claim', { leaseUntil: new Date(base + 20 * 60_000).toISOString() }],
    [30, 'fact', { note: 'Observation after the recorded lease boundary' }],
    [40, 'claim', { leaseUntil: new Date(base + 100 * 60_000).toISOString() }],
    [50, 'submit', { commit: 'b'.repeat(40) }],
  ];
  const history = entries.map(([minute, kind, detail], index) => ({ event_id: index + 1,
    event_at: new Date(base + minute * 60_000).toISOString(), event_by: 'core-1', item_id: 1,
    event_kind: kind, event_detail: JSON.stringify(detail) }));
  const counts = { submissions: 1, rejections: 0, rejectionShare: 0 };
  const observed = flowStats(history.slice(0, 3), null, base + 35 * 60_000, counts);
  assert.equal(observed.queues.open.size, 1, 'clock projection still exposes an expired claim after a non-lifecycle fact');
  assert.deepEqual(observed.report.items[0].stages.build, { minutes: 10, unknown: 0 });
  assert.deepEqual(observed.report.items[0].stages.rework, { minutes: 15, unknown: 0 });
  const completed = flowStats(history, null, base + 50 * 60_000, counts).report.items[0];
  assert.deepEqual(completed.stages.build, { minutes: 20, unknown: 0 });
  assert.deepEqual(completed.stages.rework, { minutes: 20, unknown: 0 });
});


test('cached flow retains every native milestone membership through edits removals and shipping [R1,R2]', t => {
  const base = Date.parse('2026-10-10T00:00:00Z');
  let minute = 0;
  const board = fixture(t, { now: () => new Date(base + minute * 60_000) });
  // Multiple manual memberships were legal before automatic placement; retain that history.
  board.executionEngineVersion = MILESTONE_PLACEMENT_ENGINE - 1;
  const who = { agentId: 'coordinator' };
  addMilestone(board, { ...who, name: 'A', items: [1] });
  addMilestone(board, { ...who, name: 'B', items: [1] });
  store.setLineSetting(board, { ...who, key: 'focusMilestone', value: 'A', reason: 'Private focus control', window: { items: 1 } });
  /** Compare the hot cached projection with canonical replay after each native policy transition. */
  const observe = () => {
    const now = base + minute * 60_000;
    const history = store.events(board);
    const stats = proofStats(board, { now }, statsReadPorts);
    assert.deepEqual(stats.flow.report, flowStats(history, null, now, stats).report);
    assert.deepEqual(store.events(board), history, 'observation never changes native history');
    assert.equal(stats.flow.report.overall.firstTry.unknown, 1, 'multiple groups do not duplicate the overall item');
    return stats.flow.report;
  };
  minute = 10;
  let report = observe();
  assert.deepEqual(report.items[0].milestones, ['A', 'B']);
  assert.equal(report.items[0].milestone, 'B', 'the compatibility field keeps the latest recorded membership');
  assert.deepEqual(report.items[0].stages.ready, { minutes: 10, unknown: 0 });
  assert.deepEqual(report.items[0].stages.later, { minutes: 0, unknown: 0 }, 'membership in focus A survives later membership in B');
  assert.deepEqual(report.milestones.map(row => row.milestone), ['A', 'B']);
  editMilestoneItems(board, 'B', { ...who, remove: [1] });
  minute = 20;
  assert.deepEqual(observe().items[0].milestones, ['A']);
  editMilestoneItems(board, 'B', { ...who, add: [1] });
  minute = 30;
  editMilestone(board, 'B', { ...who, newName: 'C' });
  assert.deepEqual(observe().items[0].milestones, ['A', 'C']);
  minute = 40;
  shipMilestone(board, 'A', { ...who, commit: 'a'.repeat(40), next: 'C' });
  report = observe();
  assert.deepEqual(report.items[0].milestones, ['C'], 'shipping removes only its source membership and deduplicates the target');
  assert.equal(report.items[0].milestone, 'C');
  assert.deepEqual(report.milestones.map(row => row.milestone), ['C']);
  minute = 50;
  removeMilestone(board, 'C', who);
  assert.deepEqual(observe().items[0].milestones, []);
  minute = 60;
  addMilestone(board, { ...who, name: 'D', items: [1] });
  store.setLineSetting(board, { ...who, key: 'focusMilestone', value: 'D', reason: 'Private next focus', window: { items: 1 } });
  minute = 70;
  editMilestoneItems(board, 'D', { ...who, remove: [1] });
  minute = 80;
  report = observe();
  assert.deepEqual(report.items[0].stages.ready, { minutes: 50, unknown: 0 });
  assert.deepEqual(report.items[0].stages.later, { minutes: 30, unknown: 0 });
  assert.equal(report.items[0].milestone, null);
  assert.deepEqual(report.milestones.map(row => row.milestone), [null]);
});

test('automatic placement overrides agree in cached and replayed flow after shipping [R1,R2]', t => {
  const board = fixture(t);
  const who = { agentId: 'coordinator' };
  const id = 1;
  addMilestone(board, { ...who, name: 'A', items: [id], reason: 'place in A' });
  for (const name of ['B', 'C']) addMilestone(board, { ...who, name });
  const observe = expected => {
    const now = Date.now() + 60_000;
    const stats = proofStats(board, { now }, statsReadPorts);
    const replay = flowStats(store.events(board), null, now, stats).report;
    const live = store.milestones(board).filter(row => row.items.includes(id)).map(row => row.name);
    assert.deepEqual(live, expected);
    assert.deepEqual(stats.flow.report, replay);
    assert.deepEqual(replay.items.find(row => row.id === id).milestones, expected);
  };
  observe(['A']);
  editMilestoneItems(board, 'B', { ...who, add: [id], reason: 'move to B' });
  observe(['B']);
  orderMilestoneItems(board, 'B', { ...who, items: [id], reason: 'rank within B' });
  observe(['B']);
  shipMilestone(board, 'A', { ...who, commit: 'a'.repeat(40), next: 'C' });
  observe(['B']);
  board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run('local:proof-stats:v2:report-summary');
  ensureProofCounters(board);
  observe(['B']);
});

test('repeated native landing receipts preserve the first measured landing interval [R1,R2]', t => {
  const base = Date.parse('2026-10-10T00:00:00Z');
  let minute = 0;
  const board = fixture(t, { now: () => new Date(base + minute * 60_000) });
  store.register(board, { lane: 'core', path: '/fixture/builder' });
  store.register(board, { lane: 'review', path: '/fixture/reviewer' });
  const digest = 'f'.repeat(64), commit = 'a'.repeat(40);
  minute = 1;
  store.claim(board, 1, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
    freeze: () => ({ text: '{"rows":[]}', digest }) });
  minute = 2;
  submitFixture(board, 1, { agentId: 'core-1', commit, tree: 'b'.repeat(40) });
  minute = 3;
  store.reserveReview(board, 1, { agentId: 'review-1', leaseMs: 3_600_000, policy: 'any' });
  minute = 4;
  store.verify(board, 1, { agentId: 'review-1', decision: 'ACCEPT', head: commit, digest, policy: 'any',
    note: 'Private native lifecycle fixture; no gate execution claimed.' });
  minute = 10;
  store.merged(board, 1, { agentId: 'coordinator', commit });
  const first = proofStats(board, { now: base + minute * 60_000 }, statsReadPorts).flow.report;
  assert.deepEqual(first.items[0].stages.mergeWait, { minutes: 6, unknown: 0 });
  minute = 20;
  store.merged(board, 1, { agentId: 'coordinator', commit });
  const repeated = proofStats(board, { now: base + minute * 60_000 }, statsReadPorts).flow.report;
  assert.deepEqual(repeated, first, 'another valid receipt cannot turn measured history into a gap or double its elapsed time');
  assert.deepEqual(repeated, flowStats(store.events(board), null, base + minute * 60_000, { submissions: 1, rejections: 0, rejectionShare: 0 }).report);
});

test('writers alternating between an older and a newer report version rebuild the report once in total [R1,R2]', t => {
  const board = fixture(t);
  const key = 'local:proof-stats:v2:report-summary';
  const stored = () => JSON.parse(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key).meta_value);
  const stamp = version => board.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?')
    .run(JSON.stringify({ ...stored(), data: { ...stored().data, version } }), key);
  board.db.exec(`CREATE TABLE temp.report_resets(id INTEGER PRIMARY KEY, why TEXT);
    CREATE TEMP TRIGGER report_deleted AFTER DELETE ON main.board_meta WHEN OLD.meta_key='${key}' BEGIN INSERT INTO report_resets(why) VALUES ('deleted'); END;
    CREATE TEMP TRIGGER report_zeroed AFTER UPDATE ON main.board_meta WHEN NEW.meta_key='${key}' AND json_extract(NEW.meta_value,'$.data.last')=0 BEGIN INSERT INTO report_resets(why) VALUES ('zeroed'); END;
    CREATE TEMP TRIGGER report_created AFTER INSERT ON main.board_meta WHEN NEW.meta_key='${key}' BEGIN INSERT INTO report_resets(why) VALUES ('created'); END;`);
  const resets = () => board.db.prepare('SELECT COUNT(*) AS n FROM temp.report_resets').get().n;
  // The older writer sees a stored report from older code and upgrades it: the one rebuild.
  stamp(FLOW_REPORT_VERSION - 1);
  store.addItem(board, { by: 'coordinator', lane: 'core', title: 'The older report upgrades once' });
  assert.equal(stored().data.version, FLOW_REPORT_VERSION);
  const upgrade = resets();
  assert.ok(upgrade > 0, 'the upgrade reset the report');
  // Then a newer writer stamps its version, and sometimes drops the proof summary so this code takes the full rebuild path.
  for (let round = 1; round <= 12; round += 1) {
    stamp(FLOW_REPORT_VERSION + 1);
    if (round % 2) board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run('local:proof-stats:v2:summary');
    const newer = stored();
    store.addItem(board, { by: 'coordinator', lane: 'core', title: `Alternating writer ${round}` });
    ensureProofCounters(board);
    assert.deepEqual(stored(), newer, `round ${round}: the older code leaves the newer report exactly as stored`);
  }
  assert.equal(resets(), upgrade, 'after the one upgrade no write resets, deletes or rebuilds the report');
});
