/** Capacity capability migration, cadence and rollback preserve native board authority [R1,R2]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../packages/store/index.js';
import { openBoard } from '../index.js';
import { CAPACITY_VERSION } from '../../../packages/stats/index.js';
import { readCapacity } from '../../../packages/stats/index.js';
import { ensureProofCounters } from '../../../packages/verify/index.js';
import { DERIVED_SETTING } from '../../../packages/verify/index.js';
import { deleteDerived } from '../../../packages/verify/index.js';
import { derivedProofCounter } from '../../../packages/verify/index.js';
import { derivedRows } from '../../../packages/verify/index.js';
import { refreshCapacityOutsideWrite } from '../../../packages/verify/index.js';
import { runFixtureGit } from '../../cli/tests/fixtures/child.js';

// The counters are read from the derived database, which the dual write fills while this setting is on (#8910, #8961).
process.env[DERIVED_SETTING] = '1';

const PREFIX = 'local:proof-stats:v2:capacity-';
const BASE = Date.parse('2026-10-25T12:00:00Z');

/** Use actual SQLite transactions and native appends with a controllable observation clock. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-capacity-cache-'));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  let now = BASE;
  // @pullboard-board-file persistence: capacity shards and their cursor must survive real SQLite transactions and rollbacks
  const board = openBoard(join(root, '.git', 'board.sqlite'), { now: () => new Date(now) });
  store.register(board, { lane: 'coordinator', path: root });
  refreshCapacityOutsideWrite(board, store.atomic);
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return { board, at: value => { now = value; } };
}

/** Capture only local capacity shards, including their independent cursor, as the derived database holds them. */
function shards(board) { return derivedRows(board).filter(row => row.meta_key.startsWith(PREFIX)); }

/** The same shards as board_meta holds them, for emulating an older writer that kept only that table. */
function metaShards(board) { return board.db.prepare('SELECT meta_key,meta_value FROM board_meta WHERE meta_key GLOB ? ORDER BY meta_key').all(`${PREFIX}*`); }

/** Remove every capacity shard from both stores, as a board that never had the capability. */
function dropShards(board) {
  board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(`${PREFIX}*`);
  deleteDerived(board, `${PREFIX}*`);
}

test('missing capacity capability is unknown and read-only rather than a measured empty forecast [R1,R2]', t => {
  const { board } = fixture(t);
  dropShards(board);
  const before = store.events(board);
  const prepare = board.db.prepare.bind(board.db);
  const statements = [];
  board.db.prepare = sql => { statements.push(sql); return prepare(sql); };
  const result = readCapacity(board, BASE);
  board.db.prepare = prepare;
  assert.equal(result.available, false);
  assert.equal(result.bounds.criticalPathHours, null);
  assert.equal(result.workHours, null);
  assert.equal(result.needsYou, null, 'missing approval observations are not a measured zero count');
  assert.equal(result.asOf, null, 'an unavailable migration has no measurement timestamp');
  assert.equal(result.monteCarlo.completed, 0);
  assert.deepEqual(result.curve, []);
  assert.deepEqual(store.events(board), before);
  assert.ok(!statements.some(sql => /SELECT\s+\*\s+FROM\s+event\b/iu.test(sql)), 'read does not silently replay native history');
  ensureProofCounters(board);
  assert.equal(readCapacity(board, BASE).available, true, 'ordinary writer establishes a genuinely measured empty board');
});

test('clause 2: an older writer tail is caught up without changing native history [R1,R2]', t => {
  const { board, at } = fixture(t);
  const retained = metaShards(board);
  store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Unmeasured work', brief: 'Files: src/new.js' });
  dropShards(board);
  for (const row of retained) board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(row.meta_key, row.meta_value);
  assert.equal(readCapacity(board, BASE).available, false, 'retained version alone cannot certify missed events');
  const before = store.events(board);
  at(BASE + 6 * 60_000);
  ensureProofCounters(board);
  assert.equal(derivedProofCounter(board, 'capacity-summary').last, before.at(-1).event_id);
  assert.equal(derivedProofCounter(board, 'capacity-item:1').state, 'open');
  assert.equal(readCapacity(board, BASE + 6 * 60_000).workHours, null, 'missing route measurements remain unknown after migration');
  assert.deepEqual(store.events(board), before);
});

test('capacity uses five-minute summaries fifteen-minute forecasts and nightly fits [R1,R2]', t => {
  const { board, at } = fixture(t);
  const start = readCapacity(board, BASE);
  at(BASE + 4 * 60_000);
  store.logEvent(board, 'coordinator', 'shout', null, {});
  refreshCapacityOutsideWrite(board, store.atomic);
  assert.equal(readCapacity(board, BASE).asOf, start.asOf);
  at(BASE + 6 * 60_000);
  store.logEvent(board, 'coordinator', 'shout', null, {});
  refreshCapacityOutsideWrite(board, store.atomic);
  const six = readCapacity(board, BASE + 6 * 60_000);
  assert.notEqual(six.asOf, start.asOf);
  assert.equal(six.monteCarlo.asOf, start.monteCarlo.asOf);
  at(BASE + 16 * 60_000);
  store.logEvent(board, 'coordinator', 'shout', null, {});
  refreshCapacityOutsideWrite(board, store.atomic);
  const sixteen = readCapacity(board, BASE + 16 * 60_000);
  assert.equal(sixteen.monteCarlo.asOf, sixteen.asOf);
  assert.equal(sixteen.source.fitTo, start.source.fitTo);
  at(Date.parse('2026-10-26T00:01:00Z'));
  store.logEvent(board, 'coordinator', 'shout', null, {});
  refreshCapacityOutsideWrite(board, store.atomic);
  const nightly = readCapacity(board, Date.parse('2026-10-26T00:01:00Z'));
  assert.equal(nightly.source.fitTo, '2026-10-26T00:00:00.000Z');
  assert.equal(nightly.source.fitFrom, '2026-10-19T00:00:00.000Z');
});

test('refused outer transactions roll capacity facts back with their native events [R1,R2]', t => {
  const { board, at } = fixture(t);
  const before = shards(board);
  const history = store.events(board);
  at(BASE + 20 * 60_000);
  const marker = new Error('synthetic outer refusal');
  assert.throws(() => store.atomic(board, () => {
    store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Rolled back work', brief: 'Files: src/rollback.js' });
    throw marker;
  }), error => error === marker);
  assert.deepEqual(shards(board), before);
  assert.deepEqual(store.events(board), history);
  assert.equal(readCapacity(board, BASE + 31 * 60_000).stale, true, 'read-time expiry stays explicit without a cache write');
});

test('debounced appends do not decode a growing forecast payload on every board move [R1,R2]', t => {
  const { board, at } = fixture(t);
  const prepare = board.db.prepare.bind(board.db);
  let snapshotReads = 0;
  board.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql !== 'SELECT meta_value FROM board_meta WHERE meta_key=?') return statement;
    return new Proxy(statement, { get(target, key) {
      if (key === 'get') return (...args) => {
        if (args[0] === `${PREFIX}snapshot`) snapshotReads += 1;
        return target.get(...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try {
    at(BASE + 4 * 60_000);
    for (let move = 0; move < 10; move++) store.logEvent(board, 'coordinator', 'shout', null, {});
  } finally { board.db.prepare = prepare; }
  assert.equal(snapshotReads, 0, 'a scalar cadence guard keeps the unchanged model out of the native append path');
  assert.equal(readCapacity(board, BASE).asOf, new Date(BASE).toISOString());
});


// Synthetic history is input data, not an authenticated gate proof.
test('old capacity observer versions replay typed landing outcomes without changing native events [R1,R2]', t => {
  const { board, at } = fixture(t);
  const source = 'a'.repeat(40);
  const landed = 'b'.repeat(40);
  store.logEvent(board, 'coordinator', 'add', 91, { lane: 'core', route: 'strong', after: [] });
  store.logEvent(board, 'builder', 'claim', 91, { leaseUntil: new Date(BASE + 3_600_000).toISOString() });
  store.logEvent(board, 'builder', 'submit', 91, { commit: source });
  store.logEvent(board, 'reviewer', 'accept', 91, { commit: source });
  store.logEvent(board, 'coordinator', 'merged', 91, { commit: landed });
  const before = store.events(board);
  const summary = derivedProofCounter(board, 'capacity-summary');
  board.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify({ data: { ...summary, version: 1 }, numbers: [] }), `${PREFIX}summary`);
  deleteDerived(board, `${PREFIX}summary`);
  assert.equal(readCapacity(board, BASE).available, false, 'old observer data is not silently certified');
  at(BASE + 6 * 60_000);
  ensureProofCounters(board);
  assert.equal(derivedProofCounter(board, 'capacity-summary').version, CAPACITY_VERSION);
  const outcomes = shards(board).filter(row => row.meta_key.includes('capacity-sample:'))
    .map(row => JSON.parse(row.meta_value).data).filter(row => row.kind === 'landingOutcome');
  assert.deepEqual(outcomes.map(row => [row.sourceCommit, row.failed]), [[source, false]]);
  assert.deepEqual(store.events(board), before);
});
