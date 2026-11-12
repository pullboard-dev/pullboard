/** @pullboard-test-input apps/cli/pullboard.js apps/cli/src/io/view.js */
/**
 * Every query the hot commands run reaches events and shouts through an index, never a full scan, on a
 * seeded board of 1,000 items, 45,000 events and 23,000 shouts [C7]. The commands run as the real CLI
 * with a preload that records each statement they prepare; each is then planned with EXPLAIN QUERY PLAN.
 */
import { dispatchHealth } from '../../../../packages/sentinels/index.js';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  after,
  test,
} from 'node:test';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { openBoardForRead } from '../../../lib/index.js';
import { healthReport } from '../../../../packages/health/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { personNeedsSummary } from '../../../view/index.js';
import { resumeNeeds } from '../../../view/index.js';
import { undraftedRigor } from '../../../../packages/rigor/index.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { recordSchemaStamp } from '../../../../packages/store/index.js';
import { SCHEMA_DIGEST } from '../../../../packages/store/index.js';
import {
  ensureFactIdentityIndexes,
  factIdentityExists,
} from '../../../../packages/spec/index.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const SERVE = pathToFileURL(resolve(import.meta.dirname, '../../src/io/view.js')).href;
const ITEMS = 1_000;
const EVENTS = 45_000;
const SHOUTS = 23_000;
const SEATS = 800;
const sandboxes = [];
// Writable open warms both proof and Rigor counters before these hot reads. No whole-history
// exception remains; cold readers are covered separately without weakening this hot-path check.
const WHOLE_HISTORY = [];

test('a new fact id is checked by index across current, legacy and archived facts [B29,B31,C7]', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-fact-index-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board.sqlite');
  const clock = { now: () => new Date('2026-10-24T00:00:00.000Z') };
  let board = openBoard(file, clock);
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/synthetic-fact-index' });
  const first = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'First identity owner' });
  const second = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Another identity owner' });
  /** Keep all append options fixed except the identity under test. */
  const options = (factId) => ({ agentId: 'coordinator', kind: 'note', text: 'Private identity evidence', factId });
  const insert = board.db.prepare("INSERT INTO event (event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)");
  // Explicitly synthetic legacy history, not benchmark data or ordered-move proof.
  for (let index = 0; index < 400; index += 1) {
    insert.run(clock.now().toISOString(), 'coordinator', 'fact', first, JSON.stringify({ id: `legacy-${index}`, text: 'Legacy note' }));
  }
  const plans = [];
  const prepare = board.db.prepare.bind(board.db);
  /** Record plans for actual duplicate checks without substituting their SQLite results. */
  board.db.prepare = (sql) => {
    if (/^SELECT\b/iu.test(sql) && /json_(?:extract|valid)/u.test(sql)) {
      const bindings = sql.includes('?') ? ['fresh-identity'] : [];
      plans.push({ sql, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map((row) => row.detail) });
    }
    return prepare(sql);
  };
  store.appendFact(board, first, options('fresh-identity'));
  board.db.prepare = prepare;
  const identityPlans = plans.filter(({ sql }) => sql.includes('json_extract'));
  assert.ok(identityPlans.length > 0, 'the real appendFact executed its identity lookup');
  assert.ok(identityPlans.every(({ plan }) => plan.some((detail) => /SEARCH event\b.*<expr>=\?/u.test(detail))),
    `new fact identity must search an expression index, not scan every fact: ${JSON.stringify(plans)}`);
  const legacyPlans = plans.filter(({ sql }) => sql.includes('NOT json_valid') && sql.includes("typeof(event_detail) = 'text'"));
  assert.ok(legacyPlans.length > 0 && legacyPlans.every(({ plan }) => plan.some((detail) => /USING (?:COVERING )?INDEX event_fact_malformed_v2\b/u.test(detail))),
    `legacy detection must read only its partial legacy index: ${JSON.stringify(plans)}`);
  assert.throws(() => store.appendFact(board, second, options('fresh-identity')), { code: 'BAD_FACT_ID' }, 'identity is global across items');
  assert.throws(() => store.appendFact(board, second, options('legacy-399')), { code: 'BAD_FACT_ID' });

  store.closeBoard(board);
  const legacy = new DatabaseSync(file);
  // A synthetic physical cold partition exercises compatibility without importing unlanded retention code.
  legacy.exec(`CREATE TABLE event_archive AS SELECT * FROM event WHERE 0;
    DROP INDEX event_fact_identity_v2; DROP INDEX event_fact_malformed_v2; DROP INDEX event_fact_unknown_v2;
    CREATE INDEX event_fact_identity ON event(json_extract(event_detail,'$.id')) WHERE event_kind='fact' AND json_valid(event_detail);
    CREATE INDEX event_fact_legacy ON event(event_id) WHERE event_kind='fact' AND NOT json_valid(event_detail);`);
  legacy.prepare("INSERT INTO event_archive (event_id,event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?,?)")
    .run(900000, clock.now().toISOString(), 'coordinator', 'fact', first, JSON.stringify({ id: 'cold-identity', text: 'Cold legacy note' }));
  legacy.prepare("INSERT INTO event (event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)")
    .run(clock.now().toISOString(), 'coordinator', 'fact', second, JSON.stringify({ id: 'legacy-0', text: 'Historical duplicate retained' }));
  recordSchemaStamp(legacy, SCHEMA_DIGEST);
  legacy.close();
  const older = openBoard(file, clock, { isMain: false });
  try {
    const before = older.db.prepare('SELECT * FROM event ORDER BY event_id').all();
    const schema = older.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
    assert.throws(() => store.appendFact(older, second, options('cold-identity')), { code: 'FACT_INDEX_NOT_READY' });
    assert.throws(() => store.appendFact(older, second, options('before-index-install')), { code: 'FACT_INDEX_NOT_READY' });
    assert.deepEqual(older.db.prepare('SELECT * FROM event ORDER BY event_id').all(), before, 'readiness refusal writes no native event');
    assert.deepEqual(older.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), schema, 'nonowner append performs no index DDL');
  } finally {
    store.closeBoard(older);
  }
  const readonly = store.openBoardReadOnly(file);
  assert.equal(readonly.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE '%_fact_%_v2'").get().n, 0,
    'read-only open never installs an additive index');
  readonly.close();
  const reader = openBoardForRead(file, clock);
  try {
    assert.ok(store.listItems(reader).length >= 2, 'legacy reads require no fact index');
    assert.throws(() => store.appendFact(reader, second, options('readonly-before-index-install')), { code: 'FACT_INDEX_NOT_READY' },
      'an explicit readonly append receives the owning-open step before attempting a write transaction');
  } finally { store.closeBoard(reader); }
  const beforeUpgrade = new DatabaseSync(file);
  const upgradeSchema = beforeUpgrade.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  const upgradeEvents = beforeUpgrade.prepare('SELECT * FROM event ORDER BY event_id').all();
  const upgradeMeta = beforeUpgrade.prepare('SELECT * FROM board_meta ORDER BY meta_key').all();
  beforeUpgrade.close();
  const originalExec = DatabaseSync.prototype.exec;
  /** Fail the cold-partition install only after the hot indexes were really created in its transaction. */
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes('CREATE INDEX IF NOT EXISTS event_archive_fact_identity_v2')) throw new Error('synthetic cold index install failure');
    return originalExec.call(this, sql);
  };
  try { assert.throws(() => openBoard(file, clock), /synthetic cold index install failure/u); }
  finally { DatabaseSync.prototype.exec = originalExec; }
  const failedUpgrade = new DatabaseSync(file);
  assert.deepEqual(failedUpgrade.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), upgradeSchema,
    'failed install rolls back every new hot/cold index');
  assert.deepEqual(failedUpgrade.prepare('SELECT * FROM board_meta ORDER BY meta_key').all(), upgradeMeta, 'failed install preserves the schema stamp');
  failedUpgrade.close();
  board = openBoard(file, clock);
  assert.deepEqual(board.db.prepare('SELECT * FROM event ORDER BY event_id').all(), upgradeEvents, 'owning-open upgrade preserves every native event');
  assert.equal(board.db.prepare('PRAGMA user_version').get().user_version, 3, 'index upgrade preserves the existing data schema version');
  assert.throws(() => store.appendFact(board, second, options('cold-identity')), { code: 'BAD_FACT_ID' }, 'cold identity remains reserved');
  store.appendFact(board, second, options('after-migration'));
  const coldPlans = board.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM event_archive WHERE event_kind='fact' AND json_valid(event_detail,10) AND json_extract(event_detail,'$.id')=?")
    .all('cold-identity').map((row) => row.detail);
  assert.ok(coldPlans.some((detail) => /SEARCH event_archive\b.*<expr>=\?/u.test(detail)), JSON.stringify(coldPlans));

  const move = prepareEngineMove(board, 'appendFact', [second, options('ignored-local-id')], { id: 'sealed-fact-index' });
  const replay = applyEngineMove(board, move, { sequence: 1, at: clock.now().toISOString() });
  assert.equal(replay.result.id, move.id);
  assert.deepEqual(applyEngineMove(board, move, { sequence: 1, at: clock.now().toISOString() }), replay, 'same sealed move retries its receipt');
  assert.equal(store.events(board).filter((event) => event.event_kind === 'fact' && JSON.parse(event.event_detail).id === move.id).length, 1);

  board.db.prepare("INSERT INTO event (event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)")
    .run(clock.now().toISOString(), 'coordinator', 'fact', first, "{id:'legacy-json5',text:'kept'}");
  assert.throws(() => store.appendFact(board, second, options('legacy-json5')), { code: 'BAD_FACT_ID' }, 'strict-invalid but readable JSON5 keeps its identity');
  board.db.prepare("INSERT INTO event_archive (event_id,event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?,?)")
    .run(900001, clock.now().toISOString(), 'coordinator', 'fact', first, "{id:'cold-json5',text:'kept'}");
  assert.throws(() => store.appendFact(board, second, options('cold-json5')), { code: 'BAD_FACT_ID' }, 'readable cold JSON5 keeps its global identity');
  const json5Plans = [];
  const json5Prepare = board.db.prepare.bind(board.db);
  /** Observe the real post-JSON5 lookup, with no replacement result or inferred pre-legacy plan. */
  board.db.prepare = (sql) => {
    if (/^SELECT\b/iu.test(sql) && /json_(?:extract|valid)/u.test(sql)) {
      const bindings = sql.includes('?') ? ['after-json5'] : [];
      json5Plans.push({ sql, plan: json5Prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map((row) => row.detail) });
    }
    return json5Prepare(sql);
  };
  try { store.appendFact(board, second, options('after-json5')); }
  finally { board.db.prepare = json5Prepare; }
  const json5IdentityPlans = json5Plans.filter(({ sql }) => sql.includes('json_extract'));
  assert.ok(json5IdentityPlans.length >= 2 && json5IdentityPlans.every(({ plan }) =>
    plan.some((detail) => /SEARCH event(?:_archive)?\b.*<expr>=\?/u.test(detail)) &&
    !plan.some((detail) => /SEARCH event(?:_archive)?\b.*event_kind=\?(?!.*<expr>)/u.test(detail))),
  `both physical partitions must retain indexed new-ID lookups after readable legacy JSON5: ${JSON.stringify(json5Plans)}`);

  // Coordinator27318: arbitrary corrupt binary history is unsupported, never a reason to scan or crash an append.
  const jsonb = board.db.prepare('SELECT jsonb(?) AS value').get('{"id":"unsupported-id","unused":{"tail":123}}').value;
  const corrupt = Uint8Array.from(jsonb);
  corrupt[corrupt.length - 1] = 255;
  board.db.prepare("INSERT INTO event (event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)")
    .run(clock.now().toISOString(), 'coordinator', 'fact', first, corrupt);
  board.db.prepare("INSERT INTO event_archive (event_id,event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?,?)")
    .run(900002, clock.now().toISOString(), 'coordinator', 'fact', first, corrupt);
  const unknownEvents = board.db.prepare("SELECT * FROM event WHERE typeof(event_detail)='blob'").all();
  const unknownCold = board.db.prepare("SELECT * FROM event_archive WHERE typeof(event_detail)='blob'").all();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = line => warnings.push(line);
  try {
    store.appendFact(board, second, options('unsupported-id'));
    store.appendFact(board, second, options('after-unknown'));
  } finally { console.warn = originalWarn; }
  assert.equal(warnings.length, 1, 'public append emits only one diagnostic for corrupt binary legacy facts');
  assert.match(warnings[0], /^\[FACT_ID_UNKNOWN\]/u);
  assert.deepEqual(board.db.prepare("SELECT * FROM event WHERE typeof(event_detail)='blob'").all(), unknownEvents);
  assert.deepEqual(board.db.prepare("SELECT * FROM event_archive WHERE typeof(event_detail)='blob'").all(), unknownCold);

  const beforeMalformed = board.db.prepare('SELECT count(*) AS n FROM event').get().n;
  board.db.prepare("INSERT INTO event (event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)")
    .run(clock.now().toISOString(), 'coordinator', 'fact', first, '{malformed');
  assert.throws(() => store.appendFact(board, second, options('after-malformed')), /malformed JSON/iu, 'malformed fact remains a failure, never silently ignored');
  assert.equal(board.db.prepare('SELECT count(*) AS n FROM event').get().n, beforeMalformed + 1, 'failed append has no partial event');
});


test('legacy fact SQL formats preserve parser outcomes [B29,C7]', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const jsonb = db.prepare("SELECT jsonb(?) AS value").get('{"id":"blob-id","unused":{"tail":123}}').value;
  const alteredJsonb = Uint8Array.from(jsonb);
  alteredJsonb[alteredJsonb.length - 1] = 255;
  const cases = [
    ['strict text', '{"id":"text-id"}', 'text-id'],
    ['JSON5 text', "{id:'json5-id',}", 'json5-id'],
    ['JSON text BLOB', Buffer.from('{"id":"blob-text-id"}'), 'blob-text-id'],
    ['JSON5 text BLOB', Buffer.from("{id:'blob-json5-id'}"), 'blob-json5-id'],
    ['native JSONB', jsonb, 'blob-id'],
    ['missing identity', '{"text":"note"}', null],
    ['JSON scalar', 'true', null],
    ['JSON null', 'null', null],
    ['malformed text', '{broken', undefined],
    ['malformed BLOB', Buffer.from('{broken'), undefined],
    ['altered unused JSONB tail', alteredJsonb, 'observe'],
  ];
  const observations = [];
  for (const [format, value, expected] of cases) {
    const readable = db.prepare('SELECT json_valid(?,10) AS readable').get(value).readable;
    let result;
    try { result = { value: db.prepare("SELECT json_extract(?,'$.id') AS id").get(value).id }; }
    catch (error) { result = { error: error.message, code: error.code, errcode: error.errcode }; }
    observations.push({ format, readable, result });
    if (expected === 'observe') continue;
    if (expected === undefined) assert.match(result.error, /malformed JSON/iu, format);
    else {
      assert.equal(result.value, expected, format);
      assert.equal(readable, 1, `${format}: proposed predicate retains parser-readable legacy values`);
    }
  }
  console.log(JSON.stringify({ sqlite: db.prepare('SELECT sqlite_version() AS version').get().version, legacyFormatObservations: observations }));
});


test('indexed legacy fact outcomes match the original lookup [B29,B31,C7]', (t) => {
  /** Preserve the original SQL outcome, including native SQLite errors rather than a rewritten refusal. */
  const outcome = (work) => {
    try { return { value: work() }; }
    catch (error) { return { code: error.code, errcode: error.errcode, message: error.message }; }
  };
  const cases = [
    ['duplicate first', [[1, '{"id":"same"}'], [2, '{broken']], [], 'same'],
    ['malformed first', [[1, '{broken'], [2, '{"id":"same"}']], [], 'same'],
    ['new ID with malformed', [[1, '{"id":"other"}'], [2, '{broken']], [], 'new'],
    ['JSON5 duplicate first', [[1, "{id:'same'}"], [2, '{broken']], [], 'same'],
    ['hot duplicate before cold malformed', [[9, '{"id":"same"}']], [[1, '{broken']], 'same'],
    ['hot malformed before cold duplicate', [[9, '{broken']], [[1, '{"id":"same"}']], 'same'],
    ['cold duplicate first', [[9, '{"id":"other"}']], [[1, '{"id":"same"}'], [2, '{broken']], 'same'],
    ['cold malformed first', [[9, '{"id":"other"}']], [[1, '{broken'], [2, '{"id":"same"}']], 'same'],
    ['numeric duplicate order', [[2, '{"id":"same"}'], [3, '{broken'], [10, '{"id":"same"}']], [], 'same'],
    ['numeric malformed order', [[2, '{broken'], [3, '{"id":"same"}'], [10, '{broken']], [], 'same'],
    ['large event IDs', [[9007199254740993n, '{"id":"same"}'], [9007199254740994n, '{broken']], [], 'same'],
    ['JSON text BLOB', [[2, Buffer.from('{"id":"same"}')]], [], 'same'],
    ['native JSONB hot', [[2, { jsonb: '{"id":"same"}' }]], [], 'same'],
    ['native JSONB cold', [], [[2, { jsonb: '{"id":"same"}' }]], 'same'],
    ['JSON5 text BLOB', [], [[2, Buffer.from("{id:'same'}")]], 'same'],
    ['valid scalar and absent identity', [[2, 'null'], [3, '42'], [10, '{"text":"kept"}']], [], 'new'],
  ];
  const observations = [];
  for (const [name, rows, archive, id] of cases) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(`CREATE TABLE event(event_id INTEGER PRIMARY KEY,event_kind TEXT,event_detail TEXT NOT NULL);
      CREATE INDEX event_kind_id ON event(event_kind,event_id);`);
    if (archive.length) db.exec(`CREATE TABLE event_archive(event_id INTEGER PRIMARY KEY,event_kind TEXT,event_detail TEXT NOT NULL);
      CREATE INDEX event_archive_kind_id ON event_archive(event_kind,event_id);`);
    for (const [table, data] of [['event', rows], ['event_archive', archive]]) {
      if (table === 'event_archive' && !archive.length) continue;
      for (const [eventId, detail] of data) {
        const value = detail?.jsonb ? db.prepare('SELECT jsonb(?) AS value').get(detail.jsonb).value : detail;
        db.prepare(`INSERT INTO ${table} VALUES (?,'fact',?)`).run(eventId, value);
      }
    }
    const history = archive.length ? '(SELECT * FROM event UNION ALL SELECT * FROM event_archive)' : 'event';
    const old = outcome(() => Boolean(db.prepare(`SELECT 1 FROM ${history} WHERE event_kind='fact' AND json_extract(event_detail,'$.id')=?`).get(id)));
    const native = db.prepare('SELECT CAST(event_id AS TEXT) AS event_id,event_kind,event_detail FROM event ORDER BY event.event_id').all();
    ensureFactIdentityIndexes(db);
    const indexed = outcome(() => factIdentityExists(db, id));
    observations.push({ name, old, indexed });
    assert.deepEqual(indexed, old, name);
    assert.deepEqual(db.prepare('SELECT CAST(event_id AS TEXT) AS event_id,event_kind,event_detail FROM event ORDER BY event.event_id').all(), native,
      `${name}: installing and looking up the index preserves native rows`);
  }
  const unknown = new DatabaseSync(':memory:');
  t.after(() => unknown.close());
  unknown.exec(`CREATE TABLE event(event_id INTEGER PRIMARY KEY,event_kind TEXT,event_detail TEXT NOT NULL);
    CREATE TABLE event_archive(event_id INTEGER PRIMARY KEY,event_kind TEXT,event_detail TEXT NOT NULL);`);
  const jsonb = unknown.prepare("SELECT jsonb(?) AS value").get('{"id":"unsupported-id","unused":{"tail":123}}').value;
  const corrupt = Uint8Array.from(jsonb);
  corrupt[corrupt.length - 1] = 255;
  unknown.prepare("INSERT INTO event VALUES (2,'fact',?)").run(corrupt);
  unknown.prepare("INSERT INTO event_archive VALUES (10,'fact',?)").run(corrupt);
  const messages = [];
  ensureFactIdentityIndexes(unknown);
  const unsupportedBefore = unknown.prepare('SELECT * FROM event').all();
  const observe = { onDiagnostic: line => messages.push(line) };
  assert.equal(factIdentityExists(unknown, 'unsupported-id', observe), false, 'coordinator27318: corrupt non-TEXT identity is unknown');
  assert.equal(factIdentityExists(unknown, 'another-id', observe), false);
  assert.equal(messages.length, 1, 'one named line per open connection, no diagnostic flood');
  assert.match(messages[0], /^\[FACT_ID_UNKNOWN\]/u);
  assert.deepEqual(unknown.prepare('SELECT * FROM event').all(), unsupportedBefore, 'unsupported history stays immutable');
  const plans = unknown.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM event INDEXED BY event_fact_unknown_v2 WHERE event_kind='fact' AND typeof(event_detail)<>'text' AND NOT json_valid(event_detail,10) LIMIT 1").all();
  assert.ok(plans.some(row => /USING (?:COVERING )?INDEX event_fact_unknown_v2/u.test(row.detail)), JSON.stringify(plans));
  console.log(JSON.stringify({ legacyOutcomeOracle: observations }));
});

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** Make a real repo with a coordinator and one joined builder, and return how to run the CLI there with a statement log. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-query-plans-')));
  sandboxes.push(dir);
  const log = join(dir, 'statements.log');
  const preload = join(dir, 'record.mjs');
  // Record every statement any connection prepares, so the test plans exactly what the command ran.
  writeFileSync(preload, `import { DatabaseSync } from 'node:sqlite';
import { appendFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
// Explicit development profiling preserves the normal command and timing assertion unchanged.
if (process.env.PULLBOARD_RESUME_CPU_PROFILE) {
  const { Session } = await import('node:inspector');
  const { writeFileSync } = await import('node:fs');
  const session = new Session();
  session.connect();
  const post = method => new Promise((resolve, reject) => session.post(method, (error, result) => error ? reject(error) : resolve(result)));
  await post('Profiler.enable');
  await post('Profiler.start');
  process.once('beforeExit', async () => {
    const { profile } = await post('Profiler.stop');
    writeFileSync(process.env.PULLBOARD_RESUME_CPU_PROFILE + '.' + process.pid + '.cpuprofile', JSON.stringify(profile));
    session.disconnect();
  });
}
let gitDepth = 0;
for (const name of ['spawnSync', 'execFileSync']) {
  const original = childProcess[name];
  /** Measure actual synchronous Git calls without substituting their results or environment. */
  childProcess[name] = function (command, ...args) {
    const started = performance.now();
    const git = command === 'git';
    if (git) gitDepth += 1;
    try { return original.call(this, command, ...args); }
    finally {
      if (git) gitDepth -= 1;
      if (git && gitDepth === 0 && process.env.PULLBOARD_GIT_TIMING_LOG) {
        appendFileSync(process.env.PULLBOARD_GIT_TIMING_LOG, JSON.stringify({ pid: process.pid, milliseconds: performance.now() - started }) + '\\n');
      }
    }
  };
}
syncBuiltinESMExports();
// The command's own CPU time, which waiting on a busy machine cannot inflate the way wall time is.
if (process.env.PULLBOARD_GIT_TIMING_LOG) {
  process.on('exit', () => {
    const { user, system } = process.cpuUsage();
    appendFileSync(process.env.PULLBOARD_GIT_TIMING_LOG, JSON.stringify({ pid: process.pid, cpuMilliseconds: (user + system) / 1000 }) + '\\n');
  });
}
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...rest) {
  // The function that asked: past the events() helper and serve's withProject wrapper.
  const caller = new Error().stack.split('\\n').slice(2).map((line) => /at (?:Module\\.)?([\\w$.]+) \\(/u.exec(line)?.[1])
    .find((name) => name && name !== 'events' && name !== 'withProject');
  appendFileSync(process.env.PULLBOARD_QUERY_LOG, JSON.stringify({ sql, caller, stack: new Error().stack }) + '\\n');
  return prepare.call(this, sql, ...rest);
};
`);
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${shims}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    PULLBOARD_MODEL: 'Test Model',
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  /** Run the CLI, or a node script, in a checkout; `record` adds the statement-recording preload. */
  const run = (cwd, args, { record = false, node = false, timing = false } = {}) => {
    const argv = [...(record ? ['--import', pathToFileURL(preload).href] : []), ...(node ? [] : [BIN]), ...args];
    const result = runFixtureChild(process.execPath, argv, { cwd, env: { ...env, PULLBOARD_QUERY_LOG: log,
      ...(timing ? { PULLBOARD_GIT_TIMING_LOG: join(dir, 'git-timing.log') } : {}) }, encoding: 'utf8' });
    return { code: result.status, pid: result.pid, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '' };
  };
  git('init', '-q', '-b', 'main');
  assert.equal(run(repo, ['init']).code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h',
    lanes: { web: { owns: ['web/'], specs: ['G1'] } },
  }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), '# Plans fixture\n\n## G · Goals\n- G1 [approved, must] The feature works. | gate: test\n');
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'a.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: create plans fixture');
  const made = run(repo, ['worktree', 'web', '--route', 'strong', '--json']);
  assert.equal(made.code, 0, `${made.err}\n${made.out}`);
  const board = join(git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(), 'pullboard', 'board.sqlite');
  return { dir, repo, web: JSON.parse(made.out).path, board, log, run };
}

/** Fill the board to the measured scale: seats, items, an event log, shouts, and decisions half answered. */
function seed(file, { rigor = [] } = {}) {
  const db = new DatabaseSync(file);
  const at = (n) => new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString();
  db.exec('BEGIN');
  const seat = db.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_created_at) VALUES (?, ?, ?, ?)');
  for (let n = 0; n < SEATS; n += 1) seat.run(`web-${n + 100}`, 'web', `/gone/web-${n + 100}`, at(n));
  const item = db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_created_by, item_created_at, item_updated_at)
    VALUES ('web', ?, 'The feature works.', 'coordinator', ?, ?)`);
  for (let n = 0; n < ITEMS; n += 1) item.run(`Item ${n}`, at(n), at(n));
  const event = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  const kinds = ['add', 'claim', 'renew', 'shout', 'edit'];
  for (let n = 0; n < EVENTS; n += 1) {
    const row = rigor[n];
    event.run(at(n), row?.by ?? `web-${100 + (n % SEATS)}`, row?.kind ?? kinds[n % kinds.length],
      row ? row.item : n % 10 ? 1 + (n % ITEMS) : null, JSON.stringify(row?.detail ?? {}));
  }
  const shout = db.prepare('INSERT INTO shout (shout_from, shout_to, shout_text, shout_at, shout_decision, shout_answers) VALUES (?, ?, ?, ?, ?, ?)');
  for (let n = 0; n < SHOUTS; n += 1) {
    const asks = n % 10 === 0;
    const to = asks ? (n % 20 === 0 ? 'coordinator' : 'person') : 'all';
    // Every other coordinator ask gets its answer two shouts later (shout ids start at 1).
    const answers = n % 40 === 2 ? n - 1 : null;
    shout.run(`web-${100 + (n % SEATS)}`, to, `shout ${n}`, at(n), asks ? 1 : 0, answers);
  }
  db.exec('COMMIT');
  db.close();
}

test('clause 2: coordinator resume never reads the whole event history for rigor [C7,D1,N19]', () => {
  const box = fixture();
  seed(box.board, { rigor: [
    { kind: 'reject', item: 1, detail: { cause: 'row:G1', commit: 'a'.repeat(40) } },
    { kind: 'reopen', item: 1, detail: { cause: 'row:G1', commit: 'b'.repeat(40) } },
    { kind: 'reject', item: 2, detail: { cause: 'test:test/old.js::old failure', commit: 'a'.repeat(40) } },
    { kind: 'reject', item: 3, detail: { cause: 'test:test/old.js::old failure', commit: 'a'.repeat(40) } },
    { kind: 'fact', item: 4, by: store.PERSON, detail: { cause: 'doctrine:C3', neverAgain: true } },
    { kind: 'reject', item: 5, detail: { cause: 'refusal:MERGE_CONFLICT' } },
    { kind: 'reject', item: 6, detail: { cause: 'refusal:MERGE_CONFLICT' } },
  ] });
  // Writable initialization may backfill once, before the measured read-only resume.
  const board = openBoard(box.board);
  try {
    const config = loadConfig(box.repo);
    const state = personNeedsSummary(box.repo, { board, config });
    const expected = undraftedRigor(store.events(board), state, { person: store.PERSON });
    assert.deepEqual(expected.map(cause => cause.key), ['doctrine:C3', 'test:test/old.js::old failure', 'row:G1']);
    const actual = resumeNeeds(box.repo, { board, config, includeRigorUndrafted: true });
    assert.deepEqual(actual.rigorUndrafted, expected, 'old failures survive 44,993 later unrelated events');
    writeFileSync(box.log, '');
    writeFileSync(join(box.dir, 'git-timing.log'), '');
    const started = performance.now();
    const result = box.run(box.repo, ['resume'], { record: true, timing: true });
    const wallMs = performance.now() - started;
    assert.equal(result.code, 0, result.err + result.out);
    const plans = [];
    for (const line of readFileSync(box.log, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (!/packages\/rigor\/src\/io\/counters\.js/u.test(row.stack) || !/\bFROM event\b/iu.test(row.sql)) continue;
      const bindings = row.sql.includes('?') ? [0] : []; // The only hot event parameter is the recorded integer cursor.
      const plan = board.db.prepare(`EXPLAIN QUERY PLAN ${row.sql}`).all(...bindings).map(entry => entry.detail);
      plans.push({ sql: row.sql, plan });
      assert.ok(!plan.some(detail => /^SCAN event\b/u.test(detail)), `Rigor must use indexed state/tail, never whole-history: ${row.sql}\n${plan.join('\n')}`);
    }
    assert.ok(plans.length > 0, 'the real coordinator resume executed an observed Rigor event-cursor/tail query');
    const gitMs = readFileSync(join(box.dir, 'git-timing.log'), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(row => row.pid === result.pid && row.milliseconds !== undefined)
      .reduce((total, row) => total + row.milliseconds, 0);
    const cpuMs = readFileSync(join(box.dir, 'git-timing.log'), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(row => row.pid === result.pid && row.cpuMilliseconds !== undefined)
      .reduce((total, row) => total + row.cpuMilliseconds, 0);
    assert.ok(cpuMs > 0, 'the resume process reported its own CPU time');
    assert.ok(gitMs <= wallMs, 'only actual nonoverlapping synchronous Git durations are excluded');
    console.log(`# coordinator resume wall ${wallMs.toFixed(2)} ms; actual Git ${gitMs.toFixed(2)} ms; own CPU ${cpuMs.toFixed(2)} ms`);
    // Judged by the resume process's own CPU time (Git runs in other processes), which machine load does not stretch like wall time.
    assert.ok(cpuMs < 2500, `coordinator resume used ${cpuMs.toFixed(2)} ms of CPU outside Git, over 2500 ms`); // budget: #1052's 1 s steady-state bound plus Node start and module load, stretched for a runner gating 20 files at once (seen 1711 ms with the plans and exit code passing); an events scan would cost far more.
  } finally { store.closeBoard(board); }
});

/** Add each recorded statement to `statements`, with the commands and the functions that ran it. */
function record(statements, log, command) {
  for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const { sql, caller } = JSON.parse(line);
    const seen = statements.get(sql) ?? { commands: new Set(), callers: new Set() };
    seen.commands.add(command);
    seen.callers.add(caller ?? 'unknown');
    statements.set(sql, seen);
  }
}

/** The aliases a statement gives the event and shout tables, besides their own names. */
function scanNames(sql) {
  const names = new Set(['event', 'shout', 'ask', 'reply']);
  for (const match of sql.matchAll(/\b(?:event|shout)\s+(?:AS\s+)?([A-Za-z_]\w*)/giu)) {
    if (!/^(?:WHERE|ORDER|GROUP|LIMIT|JOIN|LEFT|INNER|ON|USING|SET|VALUES|AND|OR|WHEN|INDEXED|NOT)$/iu.test(match[1])) names.add(match[1]);
  }
  return names;
}

test('clause 1: hot board queries never scan events or shouts [C7]', () => {
  const box = fixture();
  seed(box.board);
  // The commands run worktree code, which never changes a shared board's schema, so the board gets
  // its indexes the way the trunk's next open gives them.
  store.closeBoard(openBoard(box.board));
  const commands = [
    [box.repo, ['status']], [box.repo, ['list']], [box.repo, ['show', '1']], [box.repo, ['next']],
    [box.repo, ['resume']], [box.repo, ['health']],
    [box.web, ['status']], [box.web, ['list']], [box.web, ['show', '1']], [box.web, ['next']], [box.web, ['resume']],
  ];
  const statements = new Map();
  const timings = [];
  for (const [cwd, args] of commands) {
    writeFileSync(box.log, '');
    const started = performance.now();
    const result = box.run(cwd, args, { record: true });
    timings.push(`${cwd === box.repo ? 'coordinator' : 'builder'} ${args[0]} ${Math.round(performance.now() - started)} ms`);
    assert.ok(result.code === 0 || result.code === 1, `${args.join(' ')} crashed: ${result.err}`);
    record(statements, box.log, args.join(' '));
  }
  // The view's state, as the page polls it.
  writeFileSync(box.log, '');
  const view = join(box.dir, 'view-state.mjs');
  writeFileSync(view, `const { projectState } = await import(${JSON.stringify(SERVE)});\nprojectState(process.argv[2]);\n`);
  const state = box.run(box.repo, [view, box.repo], { record: true, node: true });
  assert.equal(state.code, 0, state.err);
  record(statements, box.log, 'view state');
  assert.ok(statements.size > 20, `only ${statements.size} statements were recorded`);

  const board = openBoard(box.board);
  try {
    const scans = [];
    const wholeHistory = new Set();
    for (const [sql, { commands, callers }] of statements) {
      if (!/\b(?:event|shout)\b/iu.test(sql)) continue;
      const plan = board.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail);
      const names = scanNames(sql);
      // A full scan, or an automatic index, which SQLite builds by scanning the table on every run.
      const scanned = plan.filter((detail) => {
        const match = /^(?:SCAN (\w+)|SEARCH (\w+) USING AUTOMATIC)/u.exec(detail);
        return match && names.has(match[1] ?? match[2]);
      });
      if (!scanned.length) continue;
      if ([...callers].every((caller) => WHOLE_HISTORY.includes(caller))) {
        for (const caller of callers) wholeHistory.add(caller);
        continue;
      }
      scans.push(`${[...commands].join(', ')} (${[...callers].join(', ')}): ${sql.replace(/\s+/gu, ' ').slice(0, 200)}\n    ${plan.join('\n    ')}`);
    }
    assert.deepEqual(scans, [], `${scans.length} hot statements scan events or shouts:\n${scans.join('\n')}`);
    assert.deepEqual([...wholeHistory].sort(), WHOLE_HISTORY, 'a whole-history read stopped scanning: remove it from WHOLE_HISTORY');

    // openDecisions is judged by the work it asks SQLite to do, which machine load cannot change:
    // a fixed number of statements, each reaching shouts through an index.
    const decisionStatements = [];
    const prepare = board.db.prepare.bind(board.db);
    board.db.prepare = (sql) => { decisionStatements.push(sql); return prepare(sql); };
    let open;
    try { open = store.openDecisions(board, 'coordinator'); }
    finally { board.db.prepare = prepare; }
    assert.equal(open.length, 575);
    assert.ok(decisionStatements.length < 10, `openDecisions prepared ${decisionStatements.length} statements for 575 decisions, not a fixed few`);
    const decisionScans = [...new Set(decisionStatements)].flatMap((sql) => {
      const names = scanNames(sql);
      const bindings = Array.from(sql.matchAll(/\?/gu), () => null);
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map((row) => row.detail);
      return plan.filter((detail) => {
        const match = /^(?:SCAN (\w+)|SEARCH (\w+) USING AUTOMATIC)/u.exec(detail);
        return match && names.has(match[1] ?? match[2]);
      }).map((detail) => `${sql.replace(/\s+/gu, ' ').slice(0, 200)}\n    ${detail}`);
    });
    assert.deepEqual(decisionScans, [], `openDecisions scans events or shouts:\n${decisionScans.join('\n')}`);
    console.log(`# ${timings.join('; ')}`);
  } finally {
    store.closeBoard(board);
  }
});

test('health reads item history by index [C7]', () => {
  const box = fixture();
  seed(box.board);
  const board = openBoard(box.board, { now: () => new Date('2026-10-22T22:30:00.000Z') });
  const rejectAt = '2026-10-22T21:00:00.000Z';
  const reopenAt = '2026-10-22T22:00:00.000Z';
  const submitAt = '2026-10-22T23:00:00.000Z';
  try {
    store.claim(board, 2, { agentId: 'web-100', lane: 'web', leaseMs: 60_000,
      freeze: (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` }) });
    submitFixture(board, 2, { agentId: 'web-100', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
    const event = board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
    event.run(rejectAt, 'web-100', 'reject', 1, JSON.stringify({ reason: 'TEST_FAILURE' }));
    event.run(reopenAt, 'coordinator', 'reopen', 1, '{}');
    event.run(submitAt, 'web-100', 'submit', 2, JSON.stringify({ commit: 'a'.repeat(40) }));
  } finally {
    store.closeBoard(board);
  }

  const originalPrepare = DatabaseSync.prototype.prepare;
  let historyPlans = 0;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (/\bSELECT\s+event_id\s*,\s*event_at\s*,\s*event_by\s*,\s*event_kind\s*,\s*item_id\s*,\s*event_detail\s+FROM event\b/iu.test(sql)) {
      const explanation = originalPrepare.call(this, `EXPLAIN QUERY PLAN ${sql}`);
      const plan = (sql.includes('?') ? explanation.all(1) : explanation.all()).map((row) => row.detail);
      historyPlans += 1;
      assert.ok(plan.some((detail) => /\bSEARCH event USING INDEX (?:event_item_id_event_id|event_kind_id)\b/u.test(detail)),
        `health item history must search its index before reading: ${sql}\n${plan.join('\n')}`);
      assert.ok(!plan.some((detail) => /^SCAN event\b/u.test(detail)),
        `health item history must not scan the event table: ${sql}\n${plan.join('\n')}`);
    }
    return originalPrepare.call(this, sql, ...args);
  };
  try {
    const db = store.openBoardReadOnly(box.board);
    try {
      const started = process.cpuUsage();
      const report = healthReport({ dispatchHealth, db, root: box.repo, now: new Date('2026-10-23T00:00:00.000Z') });
      const used = process.cpuUsage(started);
      const elapsed = (used.user + used.system) / 1000; // CPU time, which machine load does not stretch like wall time.
      assert.ok(historyPlans > 0, 'health planned its item-history statement');
      assert.ok(elapsed < 1_000, `health on 45,000 events used ${elapsed.toFixed(2)} ms of CPU, over 1 s`); // budget: approved row C7 requires health under 1s on the seeded board.
      const rework = report.stuck.find((entry) => entry.key === 'REWORK_UNCLAIMED:item:1');
      assert.equal(rework?.since, reopenAt, 'health keeps the latest lifecycle event for the open item');
      assert.deepEqual(rework?.detail, { move: 'reopen', by: 'coordinator' });
      const unreviewed = report.stuck.find((entry) => entry.key === 'NO_REVIEWER:item:2');
      assert.equal(unreviewed?.since, submitAt, 'health keeps the latest submit event for the submitted item');
    } finally {
      db.close();
    }
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
  }
});
