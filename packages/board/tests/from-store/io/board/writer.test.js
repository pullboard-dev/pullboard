/** A board writer applies precomputed moves in order, so a long computation holds no lock and the board never needs the writer [H24,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../../../store/index.js';
import { commitMove } from '../../../../../store/index.js';
import { connectBoardWriter } from '../../../../../store/index.js';
import { createBoardWriter } from '../../../../../store/index.js';
import { serveBoardWriter } from '../../../../../store/index.js';
import { ENGINE_VERSION } from '../../../../../state/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../../../store/tests/fixtures/submit.js';
import { temporaryRepository } from '../../../../../store/tests/fixtures/submit.js';

/** A real SQLite board file with a move table, a writer applying moves to it, and a socket serving that writer. */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-board-writer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'board.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE move (n INTEGER PRIMARY KEY AUTOINCREMENT, seat TEXT NOT NULL, note TEXT NOT NULL)');
  t.after(() => db.close());
  /** Write one move in its own transaction, as the CLI's direct write does. */
  const write = move => { db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO move (seat, note) VALUES (?, ?)').run(move.seat, move.note); db.exec('COMMIT'); return db.prepare('SELECT COUNT(*) AS n FROM move').get().n; };
  const writer = createBoardWriter({ apply: write });
  // Socket paths must stay short, whatever directory a runner gives the test.
  const socketDir = mkdtempSync(join('/tmp', 'pbw-'));
  t.after(() => rmSync(socketDir, { recursive: true, force: true }));
  const socket = join(socketDir, 'writer.sock');
  const server = await serveBoardWriter(socket, writer);
  t.after(() => server.close());
  return { dir, socketDir, file, db, write, writer, socket, rows: () => db.prepare('SELECT seat, note FROM move ORDER BY n').all().map(row => ({ ...row })) };
}

test('board.writer.a-writer-applies-a-move-at: clause 1: a writer applies a move at its snapshot version or answers changed, retry, in arrival order [H24]', async t => {
  const f = await fixture(t);
  const seat = await connectBoardWriter(f.socket);
  t.after(() => seat.close());
  const start = await seat.snapshot();
  const first = await seat.commit({ snapshot: start, touches: ['item:1'], move: { seat: 'a', note: 'first' } });
  assert.equal(first.applied, true);
  assert.equal(first.version, start + 1);
  const stale = await seat.commit({ snapshot: start, touches: ['item:1'], move: { seat: 'b', note: 'computed before the first landed' } });
  assert.equal(stale.applied, false);
  assert.equal(stale.message, 'changed, retry');
  const retried = await seat.commit({ snapshot: await seat.snapshot(), touches: ['item:1'], move: { seat: 'b', note: 'retried' } });
  assert.equal(retried.applied, true);
  assert.deepEqual(f.rows().map(row => row.note), ['first', 'retried'], 'only applied moves are written, in order');
});

test('board.writer.while-one-command-computes-with-no: clause 2: while one command computes with no lock held, twenty seats commit and none waits on it [H24]', async t => {
  const f = await fixture(t);
  const slow = await connectBoardWriter(f.socket);
  t.after(() => slow.close());
  const slowSnapshot = await slow.snapshot();
  // The slow command is computing: it holds a snapshot and no lock. Its thirty seconds are modelled by a promise the test settles last.
  let finish;
  const computing = new Promise(done => { finish = done; });
  const slowCommand = computing.then(() => slow.commit({ snapshot: slowSnapshot, touches: ['item:shared'], move: { seat: 'slow', note: 'slow result' } }));
  const seats = await Promise.all(Array.from({ length: 20 }, () => connectBoardWriter(f.socket)));
  t.after(() => seats.forEach(seat => seat.close()));
  const answers = await Promise.all(seats.map((seat, index) => seat.commit({ snapshot: slowSnapshot, touches: [`seat:${index}`], move: { seat: `s${index}`, note: 'concurrent' } })));
  assert.ok(answers.every(answer => answer.applied), 'every seat committed while the slow command was still computing');
  assert.equal(f.rows().length, 20);
  // A second connection takes the board's write lock at once: the computing command holds none.
  const other = new DatabaseSync(f.file);
  t.after(() => other.close());
  other.exec('PRAGMA busy_timeout = 0');
  other.exec('BEGIN IMMEDIATE');
  other.exec('ROLLBACK');
  finish();
  const done = await slowCommand;
  assert.equal(done.applied, true, 'the slow command touches a key no seat wrote, so it commits too');
  assert.equal(f.rows().length, 21);
});

test('board.writer.with-no-writer-running-a-command: clause 3: with no writer running a command writes the board directly, so the board never depends on the writer [H24]', async t => {
  const f = await fixture(t);
  const absent = join(f.socketDir, 'nobody-listening.sock');
  const answer = await commitMove({ socket: absent, request: { snapshot: 0, touches: ['item:1'], move: { seat: 'direct', note: 'no writer' } }, direct: f.write });
  assert.equal(answer.applied, true);
  assert.equal(answer.direct, true);
  assert.deepEqual(f.rows(), [{ seat: 'direct', note: 'no writer' }]);
  const viaWriter = await commitMove({ socket: f.socket, request: { snapshot: f.writer.snapshot(), touches: ['item:2'], move: { seat: 'writer', note: 'through the writer' } }, direct: () => assert.fail('a running writer takes the move') });
  assert.equal(viaWriter.applied, true);
  assert.equal(viaWriter.direct, undefined);
});

test('board.writer.a-socket-path-too-long-for: a socket path too long for the system is refused rather than cut into another writer\'s socket [H24]', async t => {
  const f = await fixture(t);
  const long = join(f.dir, 'x'.repeat(120), 'writer.sock');
  assert.throws(() => connectBoardWriter(long), { code: 'BOARD_WRITER_SOCKET' });
  assert.throws(() => serveBoardWriter(long, f.writer), { code: 'BOARD_WRITER_SOCKET' });
});

const SHA = 'a'.repeat(40);
const DIGEST = 'e'.repeat(64);

/** A real board file, a claimed item, its stored gate receipt, and a second connection that says whether the write lock is held. */
function gateRunFixture(t) {
  const repo = temporaryRepository(t, 'pullboard-gate-run-prepare-');
  mkdirSync(join(repo, '.git', 'pullboard'));
  const file = join(repo, '.git', 'pullboard', 'board.sqlite');
  const board = cellBoard(t, file, { now: () => new Date() }, { real: true, gitRoot: repo });
  cellSeat(board, { lane: 'coordinator', path: '/repo' });
  const seat = cellSeat(board, { lane: 'core', path: '/builder', family: 'Gate Run Vendor', route: 'mid' });
  const id = cellItem(board, { lane: 'core', title: 'Gate run', criterion: 'one', route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' }).item_id;
  store.claim(board, id, { agentId: seat.id, lane: 'core', leaseMs: 7_200_000, freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: DIGEST }) });
  const receipt = { version: 2, id: crypto.randomUUID(), kind: 'check', tree: SHA, head: SHA, main: SHA, command: 'b'.repeat(64), green: true, failures: [],
    testOutcomes: [{ file: 'test/a.test.js', name: 'a case [C7]', passed: true, skipped: false }], load: null, at: new Date().toISOString(),
    proof: { item: id, frozenDigest: DIGEST, seat: seat.id, environment: null, runner: null, exitCode: 0, counts: { passed: 1, failed: 0, skipped: 0 }, durationMs: 5, sourceClean: true } };
  const folder = join(repo, '.git', 'pullboard', 'gate-receipts');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${receipt.id}.json`), board.runtimePorts.sourceAdvanceReceipts.receiptBody(receipt));
  const probe = new DatabaseSync(file);
  probe.exec('PRAGMA busy_timeout = 0');
  t.after(() => probe.close());
  const lockHeld = () => {
    try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); return false; }
    catch (error) { if (/locked|busy/iu.test(String(error.message))) return true; throw error; }
  };
  return { board, seat, receipt, probe, lockHeld, record: () => store.writeBoardCommand(board, 'recordGateRun', [{ agentId: seat.id, receipt, lane: 'core' }], seat.id) };
}

/**
 * Count the lookups of the board file's path (the read that finds the receipt store) made inside and outside a write transaction.
 * The write lock's own bookkeeping makes the same lookup, so a case compares counts against a run that never binds a receipt.
 */
function watchLookups(f, onLookup = () => {}) {
  const seen = { inside: 0, outside: 0, begins: 0, rollbacks: 0, open: false };
  const exec = f.board.db.exec.bind(f.board.db);
  f.board.db.exec = sql => {
    if (/^\s*BEGIN/iu.test(String(sql))) { seen.open = true; seen.begins++; }
    if (/^\s*(COMMIT|END)/iu.test(String(sql))) seen.open = false;
    if (/^\s*ROLLBACK/iu.test(String(sql))) { seen.open = false; seen.rollbacks++; }
    return exec(sql);
  };
  const prepare = f.board.db.prepare.bind(f.board.db);
  f.board.db.prepare = sql => {
    if (/PRAGMA database_list/u.test(String(sql))) { seen[seen.open ? 'inside' : 'outside']++; onLookup(seen); }
    return prepare(sql);
  };
  return seen;
}

/** The gate-run events a run id has on the board. */
function gateRunEvents(f, id = f.receipt.id) {
  return f.board.db.prepare("SELECT event_id FROM event WHERE event_kind='gate-run' AND json_extract(event_detail,'$.run.id')=?").all(id);
}

test('board.writer.gate-run-binding-before-lock: clause 1: the reads recordGateRun does before its writes run in its PREPARATIONS entry with no write transaction open [C7,#10715]', t => {
  const f = gateRunFixture(t);
  const seen = watchLookups(f);
  // A run recorded with an engine version set skips the receipt binding, so its lookups are the write path's own.
  f.board.executionEngineVersion = ENGINE_VERSION;
  const other = { ...f.receipt, id: crypto.randomUUID() };
  store.writeBoardCommand(f.board, 'recordGateRun', [{ agentId: f.seat.id, receipt: other, lane: 'core' }], f.seat.id);
  const own = { inside: seen.inside, outside: seen.outside };
  f.board.executionEngineVersion = undefined;
  seen.inside = 0; seen.outside = 0;
  const result = f.record();
  assert.equal(result.run.id, f.receipt.id);
  assert.equal(seen.inside, own.inside, 'the receipt binding adds no lookup inside the write transaction');
  assert.ok(seen.outside > own.outside, 'the receipt binding is read before the write transaction opens');
  assert.equal(gateRunEvents(f).length, 1);
  assert.throws(() => store.writeBoardCommand(f.board, 'recordGateRun', [{ agentId: f.seat.id, receipt: { ...f.receipt, id: crypto.randomUUID() }, lane: 'core' }], f.seat.id), { code: 'GATE_RUN_UNBOUND' });
});

test('board.writer.gate-run-reprepares-when-stale: clause 2: a recordGateRun whose board changed between preparation and the writer re-prepares and still records the run once [C7,#10715]', t => {
  const f = gateRunFixture(t);
  let poked = false;
  const seen = watchLookups(f, state => {
    if (poked || state.open) return;
    poked = true;
    // Another connection commits while the first preparation is still running.
    f.probe.exec('CREATE TABLE IF NOT EXISTS gate_run_poke (n INTEGER)');
    f.probe.exec('INSERT INTO gate_run_poke VALUES (1)');
  });
  const result = f.record();
  assert.equal(result.run.id, f.receipt.id);
  assert.ok(poked, 'the board changed during the first preparation');
  assert.ok(seen.rollbacks >= 1, 'the stale first attempt wrote nothing');
  assert.ok(seen.begins >= 2, 'the writer opened again after preparing from the changed board');
  assert.equal(gateRunEvents(f).length, 1, 'the run is recorded once');
});

/** A real board file with a submitted item, and native ports whose conflict checks record whether a write transaction was open. */
function reopenFixture(t, onPrepare = () => {}) {
  const repo = temporaryRepository(t, 'pullboard-reopen-prepare-');
  mkdirSync(join(repo, '.git', 'pullboard'));
  const file = join(repo, '.git', 'pullboard', 'board.sqlite');
  const board = cellBoard(t, file, { now: () => new Date() }, { real: true, gitRoot: repo });
  cellSeat(board, { lane: 'coordinator', path: '/repo' });
  const seat = cellSeat(board, { lane: 'core', path: '/builder', family: 'Reopen Vendor', route: 'mid' });
  const id = cellItem(board, { lane: 'core', title: 'Reopen', criterion: 'one', route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' }).item_id;
  store.claim(board, id, { agentId: seat.id, lane: 'core', leaseMs: 7_200_000, freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: DIGEST }) });
  submitFixture(board, id, { agentId: seat.id, commit: SHA, tree: SHA });
  const probe = new DatabaseSync(file);
  probe.exec('PRAGMA busy_timeout = 0');
  t.after(() => probe.close());
  const seen = watchLookups({ board });
  const checks = { prepared: [], locked: [] };
  board.nativePorts = { ...board.nativePorts,
    conflictValue: () => ({ files: ['src/a.js'], trunk: SHA }),
    requirePreparedComputedConflict: () => { checks.prepared.push(seen.open); onPrepare(probe, checks); },
    computedConflictProblem: () => { checks.locked.push(seen.open); return null; } };
  const receipt = { version: 4, item: id, actor: 'coordinator', head: SHA, trunk: SHA, files: ['src/a.js'], submission: 1 };
  return { board, id, seen, checks, probe, reopen: () => store.writeBoardCommand(board, 'reopen', [id, { agentId: 'coordinator', computedConflict: receipt }], 'coordinator') };
}

/** The reopen events an item has on the board. */
function reopenEvents(f) {
  return f.board.db.prepare("SELECT event_id FROM event WHERE event_kind='reopen' AND item_id=?").all(f.id);
}

test('board.writer.reopen-reads-before-lock: clause 1: the reads reopen does before its writes run in its PREPARATIONS entry with no write transaction open [C7,#10721]', t => {
  const f = reopenFixture(t);
  const result = f.reopen();
  assert.equal(result.id, f.id);
  assert.deepEqual(f.checks.prepared, [false], 'the conflict receipt is checked once, before the write transaction opens');
  assert.deepEqual(f.checks.locked, [true], 'the writer still binds the receipt to the board under its own transaction');
  assert.equal(reopenEvents(f).length, 1);
});

test('board.writer.reopen-reprepares-when-stale: clause 2: a reopen whose board changed between preparation and the writer re-prepares and still reopens the item once [C7,#10721]', t => {
  let poked = false;
  const f = reopenFixture(t, probe => {
    if (poked) return;
    poked = true;
    // Another connection commits while the first preparation is still running.
    probe.exec('CREATE TABLE IF NOT EXISTS reopen_poke (n INTEGER)');
    probe.exec('INSERT INTO reopen_poke VALUES (1)');
  });
  const result = f.reopen();
  assert.equal(result.id, f.id);
  assert.ok(poked, 'the board changed during the first preparation');
  assert.ok(f.checks.prepared.length >= 2, 'the receipt was prepared again from the changed board');
  assert.ok(f.seen.rollbacks >= 1, 'the stale first attempt wrote nothing');
  assert.equal(reopenEvents(f).length, 1, 'the item is reopened once');
});
