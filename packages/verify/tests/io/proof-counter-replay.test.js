/** A replay of 100,000 proof counter events is fast and leaves the same counters the earlier replay did [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { rebuildProofCounters } from '../../src/io/proof/counters.js';
import { DERIVED_SETTING } from '../../src/io/proof/derived.js';
import { derivedRows } from '../../src/io/proof/derived.js';

const EVENTS = 100_000;
// Budget: the criterion's bar for a replay of this size (#8818, after #8562's 8 s); the replay took 71-108 s before #8562 and 7.3 s before #8818.
// It is counted in the process's own CPU seconds: runners share one machine, and a replay's wall clock there ran 2-3 times its CPU time with other jobs queued, which says nothing about the replay.
const REPLAY_SECONDS = 5;
// Digest of every stored counter row, per kind in insertion order, from the replay of these exact events before the replay was made cheap.
// The derived database keeps its rows in key order, so the digest taken from it hashes each kind's rows sorted by key: the same 314,253 rows as the insertion-order digest 01f0b10ad75f7cb2 this test held before #8963.
const BEFORE_DIGEST = '1de901d9b9dbd114';

/** The same 100,000 events every run: items cycling through add, claim, submit, accept and merge, a seventh rejected. */
function seed(db) {
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  db.exec('CREATE TABLE event(event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  const insert = db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)');
  const lanes = ['core', 'web', 'docs', 'review'];
  let clock = Date.parse('2026-10-01T00:00:00Z'), count = 0, item = 0;
  const put = (kind, by, id, detail) => { clock += 37_000; insert.run(new Date(clock).toISOString(), by, kind, id, JSON.stringify(detail)); count++; };
  db.exec('BEGIN');
  while (count < EVENTS) {
    item++;
    const by = `agent-${item % 300}`, commit = item.toString(16).padStart(8, '0').repeat(5);
    put('add', 'coordinator', item, { lane: lanes[item % 4], after: item > 3 && item % 3 === 0 ? [item - 2] : [] });
    put('claim', by, item, { leaseUntil: new Date(clock + 3_600_000).toISOString() });
    put('submit', by, item, { commit });
    put('accept', `rev-${item % 50}`, item, { commit });
    if (item % 7 === 0) put('reject', `rev-${item % 50}`, item, { commit });
    put('merged', 'board', item, {});
  }
  db.exec('COMMIT');
}

/** The digest of counter rows in the order given, and their kinds. */
function digestOf(rows) {
  const kinds = new Map();
  for (const row of rows) {
    // A flow report version keeps its keys in its own folder (report-v4:policy); the earlier replay stored them as report-policy, so compare under that name.
    const name = row.meta_key.replace(/^local:proof-stats:v\d+:/u, '').replace(/^report-v\d+:/u, 'report-');
    const kind = name.split(':')[0];
    if (!kinds.has(kind)) kinds.set(kind, createHash('sha256'));
    kinds.get(kind).update(`local:proof-stats:v2:${name}\0${row.meta_value}\n`);
  }
  const digest = createHash('sha256');
  for (const [kind, hash] of [...kinds].sort()) digest.update(kind + hash.digest('hex'));
  return { digest: digest.digest('hex').slice(0, 16), kinds: [...kinds.keys()].sort() };
}

const replayed = {};
/**
 * Replay once per mode. The timed replay runs on an in-memory board, the way the bar was set; the derived replay writes the counters to the derived database beside a file-backed board and the rows are read back from that database, not board_meta (#8963).
 * Why two: the dual write to a file database is not what the 5 s bar measures (it took 76 CPU s on a loaded runner), and the digest does not depend on the timing.
 */
function replay(derived) {
  if (replayed[derived]) return replayed[derived];
  const previous = process.env[DERIVED_SETTING];
  if (derived) process.env[DERIVED_SETTING] = '1'; else delete process.env[DERIVED_SETTING];
  try {
    const db = new DatabaseSync(derived ? join(privateFixtureFiles('pullboard-replay-').root, 'board.sqlite') : ':memory:');
    seed(db);
    const board = { db, runtimePorts: { verification: { appendRigorCounter() {}, ensureRigorCounters() {} } } };
    const start = performance.now();
    const cpuStart = process.cpuUsage();
    rebuildProofCounters(board, { refresh: false });
    const wall = (performance.now() - start) / 1000;
    const cpu = process.cpuUsage(cpuStart);
    const seconds = (cpu.user + cpu.system) / 1e6;
    const rows = derived ? derivedRows(board) : db.prepare('SELECT meta_key, meta_value FROM board_meta ORDER BY meta_key').all();
    db.close();
    return (replayed[derived] = { wall, seconds, ...digestOf(rows) });
  } finally { if (previous === undefined) delete process.env[DERIVED_SETTING]; else process.env[DERIVED_SETTING] = previous; }
}

test('clause 1: a replay of 100,000 proof counter events takes under 5 CPU seconds [C7]', t => {
  const { seconds, wall } = replay(false);
  t.diagnostic(`replay cpu ${seconds.toFixed(2)} s, wall ${wall.toFixed(2)} s`);
  assert.ok(seconds < REPLAY_SECONDS, `the replay took ${seconds.toFixed(1)} CPU s; the bar is ${REPLAY_SECONDS} s`); // budget: declared by #8818's frozen bar.
});

test('clause 2: the replayed counters, read from the derived database, equal the counters the earlier replay stored for the same events [C7]', () => {
  const { digest, kinds } = replay(true);
  assert.equal(replay(false).digest, digest, 'the in-memory replay left the same rows');
  assert.ok(kinds.includes('report-policy') && kinds.includes('item') && kinds.includes('event'), `every counter kind is stored: ${kinds}`);
  assert.equal(digest, BEFORE_DIGEST);
});
