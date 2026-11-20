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
import { DERIVED_SETTING } from '../../../../../packages/verify/index.js';
import { derivedProofCounter } from '../../../../../packages/verify/index.js';
import { ensureProofCounters } from '../../../../../packages/verify/index.js';
import { runFixtureGit } from '../../../../cli/tests/fixtures/child.js';
import { submitFixture } from '../../../../cli/tests/fixtures/board/submit.js';
import { repositoryBoardFile } from '../../../../cli/tests/fixtures/board/submit.js';
import { MILESTONE_PLACEMENT_ENGINE } from '../../../../../packages/state/light.js';

// The report counters are read from the derived database, which the dual write fills while this setting is on (#8910, #8961).
process.env[DERIVED_SETTING] = '1';

/** This code's flow report folder: each report version keeps its shards and cursor under its own name (#2288). */
const REPORT = `local:proof-stats:v2:report-v${FLOW_REPORT_VERSION}:`;
/** An older writer's report keys, which this code must leave exactly as stored. */
const LEGACY_REPORT = 'local:proof-stats:v2:report-summary';

/** Native read operations explicitly supplied to the statistics under test. */
const statsReadPorts = { events: readStatsEvents, counterProofStats: readStatsCounter };


/** Every store that holds report keys: board_meta, and the derived database once the dual write attached it [C7]. */
const reportTables = board => ['board_meta', ...(board.db.prepare('PRAGMA database_list').all().some(row => row.name === 'proof_derived') ? ['proof_derived.proof_counter'] : [])];
/** The stored rows under a glob, per store, so an older writer's boundary can be put back exactly. */
const heldRows = (board, glob) => reportTables(board).map(table => [table, board.db.prepare(`SELECT meta_key,meta_value FROM ${table} WHERE meta_key GLOB ?`).all(glob)]);
/** Emulate an older writer: drop the glob's rows from every store, then put the held rows back. */
function olderWriterRestores(board, glob, held) {
  for (const table of reportTables(board)) board.db.prepare(`DELETE FROM ${table} WHERE meta_key GLOB ?`).run(glob);
  for (const [table, rows] of held) for (const row of rows) board.db.prepare(`INSERT INTO ${table}(meta_key,meta_value) VALUES (?,?)`).run(row.meta_key, row.meta_value);
}

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

test('lib.flow-report-cache.an-empty-indexed-board-has-a: an empty indexed board has a measured empty report rather than a missing capability [R1,R2]', t => {
  const board = fixture(t, { item: false });
  const report = proofStats(board, {}, statsReadPorts).flow.report;
  assert.deepEqual(report.items, []);
  assert.deepEqual(report.lanes, []);
  assert.deepEqual(report.milestones, []);
  assert.deepEqual(report.overall.firstTry, { accepted: 0, decided: 0, rate: null, unknown: 0 });
  assert.equal(report.overall.submissionsPerLanded, null);
});

test('lib.flow-report-cache.flow-report-indexed-projection-matches-canonical: clause 2: flow report indexed projection matches canonical replay without hot raw history reads [R1,R2]', t => {
  const board = fixture(t);
  const now = Date.now() + 60_000;
  const history = store.events(board);
  const stats = proofStats(board, { now }, statsReadPorts);
  assert.deepEqual(stats.flow.report, flowStats(history, null, now, stats).report);
  assert.equal(derivedProofCounter(board, 'report-summary').last, history.at(-1).event_id, 'the derived database holds the report cursor at the latest event');
  const prepare = board.db.prepare.bind(board.db);
  const reads = [];
  board.db.prepare = sql => { reads.push(sql); return prepare(sql); };
  t.after(() => { board.db.prepare = prepare; });
  assert.deepEqual(proofStats(board, { now }, statsReadPorts).flow.report, stats.flow.report);
  assert.ok(!reads.some(sql => /SELECT\s+\*\s+FROM\s+event\b/i.test(sql)), 'current report reads indexed facts, never raw event history');
  assert.equal(proofStats(board, { now, since: '2026-10-01' }, statsReadPorts).flow.report.scope, 'all-time', 'a date-filtered legacy summary visibly labels the report scope');
});

test('lib.flow-report-cache.old-v2-counters-retain-fast-metrics: old v2 counters retain fast metrics and explicitly unavailable reports until a writer rebuilds [R1,R2]', t => {
  const board = fixture(t);
  olderWriterRestores(board, `${REPORT}summary`, []);
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

test('lib.flow-report-cache.an-older-writer-cannot-make-retained: an older writer cannot make retained report capability look current [R1,R2,H16]', t => {
  const board = fixture(t);
  const reportKeys = 'local:proof-stats:v2:report-*';
  const retained = heldRows(board, reportKeys);
  const previousEvents = store.events(board);
  store.addItem(board, { by: 'coordinator', lane: 'api', title: 'An older writer advances native history' });
  // Emulate an older writer's exact derived-state boundary: ordinary counters advance; report shards do not.
  olderWriterRestores(board, reportKeys, retained);
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

test('lib.flow-report-cache.retained-refreezes-keep-active-build-time: retained refreezes keep active build time and prototype-like recorded names remain ordinary groups [R1,R2]', () => {
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


test('lib.flow-report-cache.an-item-fact-after-claim-expiry: an item fact after claim expiry cannot reclassify the preceding active build [R1,R2]', () => {
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
  // An expired claim waits as ready work; only a reject or reopen starts rework (#7261 clause 2).
  assert.deepEqual(observed.report.items[0].stages.rework, { minutes: 0, unknown: 0 });
  const completed = flowStats(history, null, base + 50 * 60_000, counts).report.items[0];
  assert.deepEqual(completed.stages.build, { minutes: 20, unknown: 0 });
  assert.deepEqual(completed.stages.rework, { minutes: 0, unknown: 0 });
});


test('lib.flow-report-cache.cached-flow-retains-every-native-milestone: cached flow retains every native milestone membership through edits removals and shipping [R1,R2]', t => {
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

test('lib.flow-report-cache.automatic-placement-overrides-agree-in-cached: automatic placement overrides agree in cached and replayed flow after shipping [R1,R2]', t => {
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
  board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run(`${REPORT}summary`);
  ensureProofCounters(board);
  observe(['B']);
});

test('lib.flow-report-cache.repeated-native-landing-receipts-preserve-the: repeated native landing receipts preserve the first measured landing interval [R1,R2]', t => {
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

test('lib.flow-report-cache.writers-alternating-between-a-v2-shaped: clause 3: writers alternating between a v2-shaped and the current report version keep legacy keys, replay only the missed tail, and never write over 1 s [R1,R2]', t => {
  const board = fixture(t);
  const key = `${REPORT}summary`;
  const legacy = JSON.stringify({ data: { version: FLOW_REPORT_VERSION - 1, last: 1, invalid: false }, numbers: [] });
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(LEGACY_REPORT, legacy);
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('local:proof-stats:v2:report-item:1', '{"data":{"id":1},"numbers":[]}');
  const legacyRows = () => board.db.prepare("SELECT meta_key,meta_value FROM board_meta WHERE meta_key GLOB 'local:proof-stats:v2:report-[^v]*' ORDER BY meta_key").all();
  const before = legacyRows();
  assert.equal(before.length, 2, 'the v2-shaped writer left its two legacy keys');
  board.db.exec(`CREATE TABLE temp.report_resets(id INTEGER PRIMARY KEY, why TEXT);
    CREATE TEMP TRIGGER report_zeroed AFTER UPDATE ON main.board_meta WHEN NEW.meta_key='${key}' AND json_extract(NEW.meta_value,'$.data.last')=0 BEGIN INSERT INTO report_resets(why) VALUES ('zeroed'); END;
    CREATE TEMP TRIGGER report_reborn AFTER INSERT ON main.board_meta WHEN NEW.meta_key='${key}' AND json_extract(NEW.meta_value,'$.data.last')=0 BEGIN INSERT INTO report_resets(why) VALUES ('reborn'); END;`);
  const resets = () => board.db.prepare('SELECT COUNT(*) AS n FROM temp.report_resets').get().n;
  const folder = () => board.db.prepare('SELECT meta_key,meta_value FROM board_meta WHERE meta_key GLOB ?').all(`${REPORT}*`);
  for (let round = 1; round <= 6; round += 1) {
    const kept = heldRows(board, `${REPORT}*`), seen = store.events(board).length;
    const started = performance.now();
    store.addItem(board, { by: 'coordinator', lane: 'core', title: `Current writer ${round}` });
    assert.ok(performance.now() - started < 1000, `round ${round}: a current write takes under 1 s`); // budget: declared by the item bar, one second
    // Emulate the v2-shaped writer: it advances ordinary counters and its own legacy keys, but not this folder.
    store.addItem(board, { by: 'coordinator', lane: 'core', title: `Older writer ${round}` });
    olderWriterRestores(board, `${REPORT}*`, kept);
    const missed = store.events(board).slice(seen + 0).map(event => event.event_id);
    const reportEvents = [], proofEvents = [];
    board.onFlowReportEvent = event => reportEvents.push(event.event_id);
    board.onProofStatsEvent = event => proofEvents.push(event.event_id);
    const caught = performance.now();
    ensureProofCounters(board);
    assert.ok(performance.now() - caught < 1000, `round ${round}: catching up the missed tail takes under 1 s`); // budget: declared by the item bar, one second
    assert.ok(reportEvents.length > 0 && reportEvents.length <= missed.length && reportEvents.every(id => missed.includes(id)),
      `round ${round}: only the missed tail is replayed into the report`);
    assert.deepEqual(proofEvents, [], `round ${round}: ordinary proof statistics are not recounted`);
    assert.deepEqual(legacyRows(), before, `round ${round}: the legacy report keys are exactly as the older writer stored them`);
  }
  assert.equal(derivedProofCounter(board, 'report-summary').last, store.events(board).at(-1).event_id, 'the derived report cursor ends at the latest event');
  assert.equal(resets(), 0, 'no write or catch-up zeroed or restarted this version\'s report cursor');
});
