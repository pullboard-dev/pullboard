/** @pullboard-test-input source-cell packages/moves */
/** @pullboard-world-pin reads the recorded landing history fixture to replay it through the tables. The landing tables replay select, record, merged and park decisions recorded on a real board with zero disagreements, and refuse what the board refuses [C7,#8249]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { LANDING_NEXT } from '../../../index.js';
import { MOVE_REGISTRY } from '../../../index.js';
import { boardLandingEngine } from '../../../index.js';
import { landingEngine } from '../../../index.js';
import { readLandingMoveRecords } from '../../../index.js';
import { replayTable } from '../../../index.js';
import { runTable } from '../../../index.js';
import { selectBatch } from '../../../index.js';

const HISTORY = JSON.parse(readFileSync(new URL('../../fixtures/table/landing-history.json', import.meta.url), 'utf8'));
const LANDING = boardLandingEngine();

/** The recorded events on an in-memory board, shaped as the real board stores them. */
function recordedBoard() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT \'{}\')');
  const event = db.prepare('INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, at, by, kind, item, detail] of HISTORY.events) event.run(id, at, by, kind, item, JSON.stringify(detail));
  return { db };
}

const records = readLandingMoveRecords(recordedBoard(), { since: HISTORY.since, only: HISTORY.merged });
const replay = (name, list) => replayTable(LANDING.tables[name], LANDING.rules, list, { cut: HISTORY.since });
const via = (name, list) => new Set(list.flatMap(record => runTable(LANDING.tables[name], LANDING.rules, structuredClone(record.snapshot), structuredClone(record.move)).via));

const { finishLandingBatch, merged, recordLandingBatch, recordLandingTestDefect } = MOVE_REGISTRY;
const NAMES = ['select', 'record', 'merged', 'outcome'];
const clone = (value) => structuredClone(value);
const decide = (name, record, change = {}) => runTable(LANDING.tables[name], LANDING.rules, { ...clone(record.snapshot), ...change.snapshot }, { ...clone(record.move), ...change.move });

test('clause 1: replaying recorded board history through the landing tables gives zero disagreements [C7,#8249]', () => {
  const reports = Object.fromEntries(NAMES.map(name => [name, replay(name, records[name])]));
  for (const report of Object.values(reports)) assert.deepEqual(report.disagreements, []);
  for (const name of NAMES) assert.deepEqual([reports[name].total, reports[name].agreed, reports[name].notReplayable], [records[name].length, records[name].length, 0]);
  // 40 select decisions in 38 batches, 22 receipt finishes, 22 sampled hand and trunk merges, 11 refusals that decide a park or none.
  assert.deepEqual(NAMES.map(name => records[name].length), [40, 22, 22, 11]);
  assert.equal(records.selection.length, 38);
  assert.deepEqual(records.unreplayable, []);
});

test('clause 1: each batch selection walks the pending items in landing order and picks and sets aside what the board did [C7,#8249]', () => {
  for (const record of records.selection) {
    const stale = new Set(record.stale);
    const answer = selectBatch(LANDING, clone(record.snapshot), record.maximum, id => (stale.has(id) ? { staleVerdict: { reason: 'stale' } } : {}));
    const key = (entry) => `${entry.id}@${entry.commit}${entry.reviewedCommit ? `>${entry.reviewedCommit}` : ''}`;
    assert.deepEqual(answer.ready.map(key), record.wantReady, `batch event ${record.event.id} ready`);
    assert.deepEqual(answer.blocked.map(entry => `${entry.id}:${entry.code}`).sort(), record.wantBlocked, `batch event ${record.event.id} blocked`);
  }
});

test('clause 1: the replay covers a candidate, a finished landing, a plain and a forced merge and a repeat park [C7,#8249]', () => {
  assert.deepEqual([...via('select', records.select)], ['ready']);
  assert.deepEqual([...via('record', records.record)], ['land']);
  assert.deepEqual([...via('merged', records.merged)].sort(), ['forced-unfinished', 'merge']);
  const parks = records.outcome.filter(record => record.recorded.events.length);
  assert.ok(parks.length >= 1, 'a repeat park replayed');
  assert.ok(parks.every(record => /^landing-repeat-v1:\{.*\} landing parked #\d+$/u.test(record.recorded.events[0].detail.reason)));
});

test('clause 1: a recorded decision replayed with one captured fact broken is a disagreement the replay names [C7,#8249]', () => {
  const [record] = records.record;
  const stranger = { ...clone(record), move: { ...clone(record.move), actor: 'someone-else' } };
  assert.deepEqual(replay('record', [stranger]).disagreements.map(entry => [entry.event, entry.table.code]), [[record.event.id, 'COORDINATOR_ONLY']]);
  const [pick] = records.select;
  const held = { ...clone(pick), snapshot: { ...clone(pick.snapshot), item: { ...clone(pick.snapshot.item), holdReason: 'held' } } };
  assert.deepEqual(replay('select', [held]).disagreements.map(entry => [entry.event, entry.table.code]), [[pick.event.id, 'ITEM_HELD']]);
});

test('clause 1: the select table refuses in the order the lander walks, with its words and next steps [C7,#8249]', () => {
  const [pick] = records.select;
  const item = (change) => ({ snapshot: { item: { ...clone(pick.snapshot.item), ...change } } });
  const refuse = (change) => decide('select', pick, change).refused;
  assert.equal(refuse(item({ status: 'open' })).code, 'NOT_PENDING');
  assert.equal(refuse(item({ mergedCommit: 'a'.repeat(40) })).message, `#${pick.move.id} is already landed`);
  assert.deepEqual([refuse(item({ holdReason: 'waiting on the person' })).code, refuse(item({ holdReason: 'waiting on the person' })).message], ['ITEM_HELD', 'waiting on the person']);
  assert.equal(refuse({ snapshot: { io: { staleVerdict: { reason: 'main moved' } } } }).message, 'main moved');
  assert.equal(refuse(item({ after: [999999] })).code, 'WAITS_ON_ITEM');
  assert.match(refuse(item({ after: [999999] })).message, /^waits on unmerged item\(s\) #999999$/u);
  assert.equal(refuse(item({ after: [999999] })).next, LANDING_NEXT.WAITS_ON_ITEM);
  const red = (entry) => ({ id: 'b', state: 'blocked', base: 'x', items: [entry], failures: [{ file: 'a.test.js' }] });
  const entry = { id: pick.move.id, commit: pick.snapshot.item.commit };
  assert.equal(refuse({ snapshot: { batches: [red(entry), red(entry), red(entry)] } }).code, 'LAND_REPEATED_RED');
  assert.equal(decide('select', pick, { snapshot: { batches: [red(entry), red(entry)] } }).via[0], 'ready');
  const known = { id: 'k', state: 'blocked', base: 'x', items: [entry], culprits: [{ ...entry, tests: [{ file: 'a.test.js', name: 'case' }] }] };
  assert.equal(refuse({ snapshot: { batches: [known] } }).code, 'LAND_KNOWN_RED');
  const waiver = { test: 'a.test.js', until: '2099-01-01T00:00:00.000Z' };
  assert.equal(decide('select', pick, { snapshot: { batches: [known], waivers: [waiver] } }).via[0], 'ready');
  const runner = { id: 'r', state: 'blocked', base: pick.snapshot.base, items: [entry], refusals: [{ code: 'RUNNER_SOURCE' }, { code: 'RUNNER_SOURCE' }, { code: 'RUNNER_SOURCE' }] };
  assert.equal(refuse({ snapshot: { batches: [runner] } }).code, 'LAND_RUNNER_SOURCE_HELD');
  assert.equal(refuse({ snapshot: { io: { redFiles: ['a.js'], changedFiles: ['a.js'] } } }).code, 'PUBLISH_RED_FILE');
  assert.equal(refuse({ snapshot: { collisionFree: true, picked: { touched: { 'a.js': 1 } }, io: { changedFiles: ['a.js'] } } }).message, 'shares a.js');
});

test('clause 1: the record and merged tables refuse in the order the board throws, with its words [C7,#8249]', () => {
  const [land] = records.record;
  const refuse = (change) => decide('record', land, change).refused;
  assert.equal(refuse({ move: { actor: 'core-1' } }).code, 'COORDINATOR_ONLY');
  assert.equal(refuse({ move: { fence: { ...land.move.fence, token: 'other' } } }).code, 'LAND_LEASE_LOST');
  assert.equal(refuse({ move: { tip: 'f'.repeat(40) } }).message, 'the pushed tip must match its recorded batch; run pullboard land --adopt');
  assert.equal(refuse({ snapshot: { batch: { ...clone(land.snapshot.batch), state: 'building' } } }).message, 'record a successful push before landing receipts; run pullboard land --adopt');
  const [first] = land.snapshot.batch.items;
  const moved = (change) => refuse({ snapshot: { items: { ...clone(land.snapshot.items), [first.id]: { ...clone(land.snapshot.items[first.id]), ...change } } } });
  assert.equal(moved({ commit: 'e'.repeat(40) }).message, `item #${first.id} changed after the batch was gated`);
  assert.equal(moved({ checked: 'e'.repeat(40) }).message, `item #${first.id} re-reviewed after the batch was gated`);
  assert.equal(moved({ mergedCommit: 'e'.repeat(40) }).message, `item #${first.id} already has another landing receipt`);
  const [merge] = records.merged;
  const stop = (change) => decide('merged', merge, change).refused;
  assert.equal(stop({ move: { actor: 'core-1' } }).code, 'COORDINATOR_ONLY');
  assert.deepEqual([stop({ move: { forced: '  ' } }).code, stop({ move: { forced: '  ' } }).next], ['FORCED_REASON', LANDING_NEXT.FORCED_REASON]);
  assert.deepEqual([stop({ move: { forced: undefined }, snapshot: { item: { id: 1, status: 'open' } } }).code, stop({ move: { forced: undefined }, snapshot: { item: { id: 1, status: 'open' } } }).next], ['NOT_VERIFIED', LANDING_NEXT.NOT_VERIFIED]);
});

test('clause 1: the commands read their refusal wording and next steps from the landing table [C7,#8249]', () => {
  for (const code of ['LAND_BATCH', 'LAND_ITEM_MOVED', 'LAND_NOT_PUSHED']) assert.equal(finishLandingBatch.nextSteps[code], LANDING_NEXT[code]);
  assert.equal(recordLandingBatch.nextSteps.LAND_BATCH, LANDING_NEXT.LAND_BATCH);
  assert.equal(recordLandingTestDefect.nextSteps.LAND_TEST_DEFECT, LANDING_NEXT.LAND_TEST_DEFECT);
  assert.deepEqual([merged.nextSteps.NOT_VERIFIED, merged.nextSteps.FORCED_REASON], [LANDING_NEXT.NOT_VERIFIED, LANDING_NEXT.FORCED_REASON]);
  assert.equal(LANDING_NEXT.LAND_BATCH, 'adopt the recorded batch: pullboard land --adopt');
  assert.throws(() => landingEngine({ limits: {} }), { code: 'LANDING_TABLE_INPUTS' });
});

test('clause 1: the admit and outcome tables hold the trunk, adopt, park and return as the lander does [C7,#8249]', () => {
  const state = { now: '2026-11-15T12:00:00.000Z', batches: [], defects: [], waivers: [], io: { trunk: { commit: 'a'.repeat(40), branch: 'main' } } };
  const admit = (change, move = {}) => runTable(LANDING.tables.admit, LANDING.rules, { ...state, ...change }, { name: 'admit', ...move });
  assert.equal(admit({ io: {} }).refused.code, 'LAND_TRUNK');
  assert.equal(admit({ defects: [{ item: 7, itemStatus: 'open', branch: 'main', test: 't.test.js', names: ['c'] }] }).refused.code, 'LAND_TEST_DEFECT');
  assert.equal(admit({ defects: [{ item: 7, itemStatus: 'open', branch: 'main', test: 't.test.js', names: ['c'] }], io: { ...state.io, defectReleased: { 't.test.js': true } } }).via[0], 'select');
  const half = { id: 'h', state: 'pushed', base: 'b', items: [] };
  assert.deepEqual([admit({ batches: [half] }).refused.code, admit({ batches: [half] }).refused.next], ['LAND_ADOPT', LANDING_NEXT.LAND_ADOPT]);
  assert.equal(admit({ batches: [half] }, { adopt: true }).events[0].detail.batch, 'h');
  assert.equal(admit({}, { adopt: true }).refused.code, 'LAND_ADOPT');
  const outcome = (move, change = {}) => runTable(LANDING.tables.outcome, LANDING.rules, { batch: { id: 'o', state: 'building', base: 'b', items: [{ id: 5, commit: 'c' }] }, batches: [], perItem: true,
    items: { 5: { holdReason: null, mergedCommit: null } }, waivers: [], now: state.now, io: {}, ...change }, { name: 'outcome', ...move });
  assert.deepEqual(outcome({ refusal: { code: 'LAND_LEASE_LOST' } }).via, ['lease-lost']);
  assert.deepEqual(outcome({ refusal: { code: 'BOARD_BUSY' } }).patch, { state: 'blocked' });
  assert.deepEqual(outcome({ refusal: { code: 'LAND_STATIC_RED' } }).via, ['item-refused']);
  assert.deepEqual(outcome({ refusal: { code: 'GATE_RED', message: 'tests are red' } }).via, ['refused']);
  assert.deepEqual(outcome({ culprit: true }).via, ['culprit']);
  assert.deepEqual(outcome({}, { io: { gate: { isGreen: true } } }).patch, { state: 'ready' });
  assert.deepEqual(outcome({}).via, ['return-culprit']);
  assert.deepEqual(outcome({}, { perItem: false }).via, ['bisect']);
});
