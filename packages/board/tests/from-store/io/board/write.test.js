/** @pullboard-test-input source-cell packages/board */
/**
 * A board write lands within a second whatever stale holder records, long readers and busy gate workers surround it [B3,C7].
 * This test uses a real Git checkout and a real SQLite board.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { closeCellBoard } from '../../../fixtures/cell-board.js';
import { openCellBoard } from '../../../fixtures/cell-board.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import {
  beginImmediateQueued,
  boardWriteHolderText,
  configureBoardJournal,
  prepareBoardWriteIdentity,
} from '../../../../../store/index.js';
import { readdirSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import * as store from '../../../../../store/index.js';
import { submitPreflight } from '../../../../../items/index.js';
import { fixtureMachineSettings } from '../../../../../gate/tests/fixtures/testkit.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';
import { temporaryRepository } from '../../../../../store/tests/fixtures/submit.js';

/** The pid of a process that has already exited. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

/** Start a child process that runs `source` against the board, and resolve once it prints ready. */
function boardChild(source, board) {
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', source, board], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.closed = new Promise((done) => child.once('close', done));
  child.ready = new Promise((done, fail) => {
    child.stdout.setEncoding('utf8').on('data', (text) => { if (text.includes('ready')) done(); });
    child.once('close', (code) => fail(new Error(`board child exited ${code} before it was ready`)));
  });
  return child;
}

test('board.write.board-write-lands-under-1-past: a board write lands in under 1 s past stale holder records, a long reader and a busy gate worker [C7]', { timeout: 60_000 }, async t => {
  const box = cellProject(t);
  closeCellBoard(openCellBoard(box.boardFile));
  const board = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // Stale records like the 23 found on 9 Nov: dead writers, and a live pid whose start time is not the record's.
  const holders = board + '.write-holders';
  mkdirSync(holders, { recursive: true });
  const stale = [];
  for (let index = 0; index < 20; index += 1) {
    const pid = index === 0 ? process.pid : deadPid();
    const file = join(holders, `${pid}-${createHash('sha256').update(String(index)).digest('hex').slice(0, 8)}-0000-4000-8000-000000000000.json`);
    writeFileSync(file, JSON.stringify({ version: 1, pid, started: 'Mon Oct 26 14:56:00 2026', processSha256: 'a'.repeat(64),
      command: 'shout', seat: 'core-699', acquiredAt: Date.now() - 86_400_000, contender: true }) + '\n');
    stale.push(file);
  }
  // A reader that holds one read transaction open throughout, like a long state build.
  const reader = boardChild(`
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    db.exec('BEGIN'); db.prepare('SELECT COUNT(*) FROM event').get();
    process.stdout.write('ready\\n');
    process.stdin.on('end', () => { db.exec('COMMIT'); db.close(); }).resume();`, board);
  // A gate worker that keeps reading and writing short transactions, like recordGateRun.
  const worker = boardChild(`
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout = 10000');
    let stop = false, writes = 0;
    process.stdin.on('end', () => { stop = true; }).resume();
    const beat = () => {
      if (stop) { db.close(); return; }
      db.prepare('SELECT COUNT(*) FROM item').get();
      db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO board_meta(meta_key, meta_value) VALUES ('local:gate-worker-beat', ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value").run(String(++writes));
      db.exec('COMMIT');
      if (writes === 3) process.stdout.write('ready\\n');
      setTimeout(beat, 5);
    };
    beat();`, board);
  try {
    await Promise.all([reader.ready, worker.ready]);
    const latencies = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = performance.now();
      const db = new DatabaseSync(board);
      try {
        db.exec('PRAGMA busy_timeout = 10000');
        configureBoardJournal(db);
        prepareBoardWriteIdentity();
        beginImmediateQueued(db, Date.now());
        db.prepare("INSERT INTO board_meta(meta_key, meta_value) VALUES ('local:write-latency', ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value").run(String(attempt));
        db.exec('COMMIT');
      } finally { db.close(); }
      latencies.push(performance.now() - started);
    }
    const worst = Math.max(...latencies);
    assert.ok(worst < 1_000, `a board write took ${Math.round(worst)} ms with a reader and a gate worker active`); // budget: declared ceiling, the 9 Nov target of any board write under 1 s.
    assert.equal(boardWriteHolderText(board), '', 'no stale record is reported as a writer');
    for (const file of stale) assert.equal(existsSync(file), false, `${resolve(file)} is reclaimed`);
  } finally {
    reader.stdin.end();
    worker.stdin.end();
    await Promise.all([reader.closed, worker.closed]);
  }
  const db = new DatabaseSync(board, { readOnly: true });
  try { assert.equal(db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'local:write-latency'").get().meta_value, '4'); }
  finally { db.close(); }
});

const COMMIT = 'a'.repeat(40);
const POLICY = { version: 1, commit: COMMIT, verify: { policy: 'any', family: 'off' } };
const PROOF = { version: 1, files: [], full: false, deferred: true, reason: 'synthetic board-state fixture; no gate execution' };
/** The submit source's own frame: a read whose direct caller is submit.js is one of the submit's reads. */
const SUBMIT_SOURCE = /[/\\]store[/\\]src[/\\]io[/\\]board[/\\]submit\.js:/u;

/** Sleep the thread, as a slow git child or settings read does on a loaded machine. */
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A real board file in a policy repository, one claimed item, and a second connection that says whether the write lock is held. */
function fixture(t) {
  const repo = temporaryRepository(t, 'pullboard-submit-prepare-');
  mkdirSync(join(repo, '.git', 'pullboard'));
  const file = join(repo, '.git', 'pullboard', 'board.sqlite');
  const board = cellBoard(t, file, { now: () => new Date() }, { real: true, gitRoot: repo });
  cellSeat(board, { lane: 'coordinator', path: '/repo' });
  const builder = cellSeat(board, { lane: 'core', path: '/builder', family: 'Prepared Builder Vendor', route: 'mid' });
  const id = cellItem(board, { lane: 'core', title: 'prepared submit', criterion: 'one', route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' }).item_id;
  const freeze = item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: POLICY }), digest: 'digest:prepared' });
  store.claim(board, id, { agentId: builder.id, lane: 'core', leaseMs: 7_200_000, freeze });
  const probe = new DatabaseSync(file);
  probe.exec('PRAGMA busy_timeout = 0');
  t.after(() => probe.close());
  const lockHeld = () => {
    try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); return false; }
    catch (error) { if (/locked|busy/iu.test(String(error.message))) return true; throw error; }
  };
  return { board, file, builder, id, lockHeld };
}

/**
 * Watch the submit's own reads: the repository (git and the family policy), moves.shadow and moves.live. Each read whose
 * caller is submit.js records whether the write lock was held then, and the settings reads take `delayMs`, as a loaded machine's do.
 */
function watchReads(f, delayMs = 0) {
  const seen = [];
  const watch = (name, value, delay) => Object.defineProperty(f.board, name, { configurable: true, get() {
    if (SUBMIT_SOURCE.test(String(new Error().stack).split('\n')[2] ?? '')) {
      seen.push({ name, locked: f.lockHeld() });
      if (delay) sleep(delay);
    }
    return value;
  } });
  watch('gitRoot', f.board.gitRoot, 0);
  watch('movesShadow', false, delayMs);
  watch('movesLive', { submit: false }, delayMs);
  return seen;
}

const preflight = (f, agentId, atomic = store.atomic) => submitPreflight(f.board, f.id, { agentId, commit: COMMIT, tree: COMMIT },
  { atomic, submit: store.submit, prepareSubmit: store.prepareSubmit });

test('board.write.preflight-reads-before-lock: clause 1: a submit preflight reads the family policy and the moves settings before the write lock, writes nothing, and refuses what the submit refuses [C7]', t => {
  const f = fixture(t);
  const seen = watchReads(f);
  const before = store.exportBoard(f.board);
  preflight(f, f.builder.id);
  for (const name of ['gitRoot', 'movesShadow', 'movesLive']) assert.ok(seen.some(read => read.name === name), `the submit read ${name}`);
  assert.deepEqual(seen.filter(read => read.locked), [], 'no submit read ran while the write lock was held');
  assert.deepEqual(store.exportBoard(f.board), before, 'the dry run wrote nothing');
  const other = cellSeat(f.board, { lane: 'core', path: '/other', family: 'Other Builder Vendor', route: 'mid' });
  assert.throws(() => preflight(f, other.id), { code: 'NOT_YOURS' }, 'the preflight refuses a seat that does not hold the item');
  assert.throws(() => store.submit(f.board, f.id, { agentId: other.id, commit: COMMIT, tree: COMMIT, submissionProof: PROOF }), { code: 'NOT_YOURS' }, 'as the submit does');
});

test('board.write.preflight-waiter-wait: clause 2: a writer that waits on a submit preflight waits for its dry-run write, not its reads [C7]', async t => {
  const f = fixture(t);
  const READ_MS = 400;
  watchReads(f, READ_MS);
  // The waiter is another thread with its own connection: it asks for the write lock once the preflight holds it and reports its wait.
  const flags = new Int32Array(new SharedArrayBuffer(8)); // [0] the preflight holds the lock, [1] the waiter is asking
  const waiter = new Worker(`const { DatabaseSync } = require('node:sqlite'); const { parentPort, workerData } = require('node:worker_threads');
    const db = new DatabaseSync(workerData.file); db.exec('PRAGMA busy_timeout = 60000'); const flags = workerData.flags;
    Atomics.wait(flags, 0, 0, 30000); Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
    const at = performance.now(); db.exec('BEGIN IMMEDIATE'); const waited = performance.now() - at; db.exec('ROLLBACK'); db.close();
    parentPort.postMessage(Math.round(waited));`, { eval: true, workerData: { file: f.file, flags } });
  t.after(() => waiter.terminate());
  const reported = new Promise((resolve, reject) => { waiter.once('message', resolve); waiter.once('error', reject); });
  await new Promise(resolve => waiter.once('online', resolve));
  let holdMs = 0;
  const held = (board, work, options) => store.atomic(board, () => {
    const at = performance.now();
    Atomics.store(flags, 0, 1);
    Atomics.notify(flags, 0);
    Atomics.wait(flags, 1, 0, 10000);
    try { return work(); } finally { holdMs = Math.round(performance.now() - at); }
  }, options);
  preflight(f, f.builder.id, held);
  const waitedMs = await reported;
  t.diagnostic(`preflight hold ${holdMs} ms; waiter waited ${waitedMs} ms; the submit's reads took ${2 * READ_MS} ms`);
  assert.ok(Number.isFinite(waitedMs), 'the waiter reported its wait');
  assert.ok(waitedMs < READ_MS, `the waiter waited ${waitedMs} ms, under one ${READ_MS} ms read`);
});

test('board.write.submit-preparation-wired: clause 3: the native submit through writeBoardCommand prepares before the write lock and submits [C7]', t => {
  const f = fixture(t);
  const seen = watchReads(f);
  store.writeBoardCommand(f.board, 'submit', [f.id, { agentId: f.builder.id, commit: COMMIT, tree: COMMIT, submissionProof: PROOF }], f.builder.id);
  for (const name of ['gitRoot', 'movesShadow', 'movesLive']) assert.ok(seen.some(read => read.name === name), `the submit read ${name}`);
  assert.deepEqual(seen.filter(read => read.locked), [], 'no submit read ran while the write lock was held');
  assert.equal(store.getItem(f.board, f.id).item_status, 'submitted');
});

const HANDOFF_WRITES = ['queueSubmitHandoff', 'startSubmitHandoff', 'completeSubmitHandoff'];

/** A private machine home holding the given settings, for the life of the test. */
function machineHome(t, settings) {
  const home = join(temporaryRepository(t, 'pullboard-submit-queue-home-'), 'machine-home');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, settings);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; });
  return join(home, 'board-write-queue');
}

/** The hand-off write's arguments: a job that was never queued, so the move itself refuses or no-ops; only the route is under test. */
const handoffArgs = (f, operation) => [f.id, { agentId: f.builder.id, job: `${operation}-never-queued`, result: { code: 1 } }];

test('board.write.submit-handoff-queued: clause 1: with board.crossProcessWrites on, the three submit hand-off writes go through the machine file write queue and return a promise [C7]', async t => {
  const queue = machineHome(t, { board: { crossProcessWrites: true } });
  const f = fixture(t);
  for (const operation of HANDOFF_WRITES) {
    const before = existsSync(queue) ? readdirSync(queue).filter(name => name.endsWith('.result')).length : 0;
    const call = store.writeBoardCommand(f.board, operation, handoffArgs(f, operation), f.builder.id);
    assert.equal(typeof call?.then, 'function', `${operation} returns a promise, as the file queue answers across processes`);
    await call.catch(() => {});
    assert.equal(readdirSync(queue).filter(name => name.endsWith('.result')).length, before + 1, `${operation} left its own result file in the queue folder`);
  }
});

test('board.write.submit-handoff-direct: clause 2: with board.crossProcessWrites off, the three submit hand-off writes go direct as today, with no queue folder and no promise [C7]', t => {
  const queue = machineHome(t, {});
  const f = fixture(t);
  for (const operation of HANDOFF_WRITES) {
    let answer;
    try { answer = store.writeBoardCommand(f.board, operation, handoffArgs(f, operation), f.builder.id); } catch { answer = undefined; /* a direct refusal throws in the caller */ }
    assert.equal(typeof answer?.then, 'undefined', `${operation} did not return a promise`);
  }
  assert.equal(existsSync(queue), false, 'no queue folder was made');
});
