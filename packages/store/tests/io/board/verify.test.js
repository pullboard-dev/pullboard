/** A verdict's table reads (item history, verdicts, seat flakes) run before the board's write lock, so verify holds it only to write [C7,#10868]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../index.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';
import { temporaryRepository } from '../../fixtures/submit.js';

const COMMIT = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);
const POLICY = { version: 1, commit: COMMIT, verify: { policy: 'any', family: 'off' } };
const PROOF = { version: 1, files: [], full: false, deferred: true, reason: 'synthetic board-state fixture; no gate execution' };
/** The reads the verify table takes from the board: the item's history, its verdict rows and the reviewing seat's flake observations. */
const TABLE_READS = Object.freeze({ history: /event_kind IN \(/u, verdicts: /FROM verdict WHERE item_id=\?/u, flakes: /SELECT event_id id, event_detail d FROM event/u });

/** A real board file, two submitted items from one builder, a reviewing seat, and a second connection that says whether the write lock is held. */
function fixture(t) {
  const repo = temporaryRepository(t, 'pullboard-verify-prepare-');
  mkdirSync(join(repo, '.git', 'pullboard'));
  const file = join(repo, '.git', 'pullboard', 'board.sqlite');
  const board = cellBoard(t, file, { now: () => new Date() }, { real: true, gitRoot: repo });
  cellSeat(board, { lane: 'coordinator', path: '/repo' });
  const builder = cellSeat(board, { lane: 'core', path: '/builder', family: 'Prepared Builder Vendor', route: 'mid' });
  const reviewer = cellSeat(board, { lane: 'review', path: '/reviewer', family: 'Prepared Reviewer Vendor', route: 'strong' });
  const freeze = item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: POLICY }), digest: 'digest:prepared' });
  const submitted = title => {
    const id = cellItem(board, { lane: 'core', title, criterion: 'one', route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' }).item_id;
    store.claim(board, id, { agentId: builder.id, lane: 'core', leaseMs: 7_200_000, freeze });
    store.writeBoardCommand(board, 'submit', [id, { agentId: builder.id, commit: COMMIT, tree: COMMIT, submissionProof: PROOF }], builder.id);
    return id;
  };
  const probe = new DatabaseSync(file);
  probe.exec('PRAGMA busy_timeout = 0');
  t.after(() => probe.close());
  const lockHeld = () => {
    try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); return false; }
    catch (error) { if (/locked|busy/iu.test(String(error.message))) return true; throw error; }
  };
  /** The verify table decides a verdict only on a board running the current engine, as the command's board does; set once the items are submitted. */
  const current = () => { board.executionEngineVersion = ENGINE_VERSION; };
  return { board, file, reviewer, submitted, lockHeld, current };
}

/** Record each table read the board prepares, and whether the write lock was held when it was prepared. */
function watchTableReads(f) {
  const seen = [];
  const prepare = f.board.db.prepare.bind(f.board.db);
  f.board.db.prepare = sql => {
    for (const [name, pattern] of Object.entries(TABLE_READS)) if (pattern.test(String(sql))) seen.push({ name, locked: f.lockHeld() });
    return prepare(sql);
  };
  return seen;
}

/** What a verdict asks for: an accept of the submitted head with its sealed review. */
function accept(f, id) {
  const item = store.getItem(f.board, id);
  return { agentId: f.reviewer.id, decision: 'ACCEPT', head: item.item_commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off',
    note: 'Synthetic fixture accept: read the diff against the bar.', review: { commit: item.item_commit, head: item.item_commit, trunk: TRUNK, paths: [] } };
}

/** The verdict events an item holds, as written, without the actor's model. */
function verdictEvents(f, id) {
  return f.board.db.prepare("SELECT event_kind kind, event_by by, event_detail d FROM event WHERE item_id=? AND event_kind IN ('accept','reject') ORDER BY event_id").all(id)
    .map(({ kind, by, d }) => { const { model, ...detail } = JSON.parse(d); return { kind, by, detail }; });
}

test('store.io-board-verify.finish-reads-before-lock: clause 1: the reads a verdict needs that do not depend on its write run before the write lock, and the verdict events are unchanged [C7,#10868]', async t => {
  // Loaded here so main, which has no such export, still runs this file's measurement case.
  const { prepareVerdictFacts } = await import('../../../src/io/board/verify.js');
  const f = fixture(t);
  const prepared = f.submitted('prepared verdict');
  const plain = f.submitted('plain verdict');
  f.current();
  const seen = watchTableReads(f);
  const facts = prepareVerdictFacts(f.board, prepared, accept(f, prepared));
  assert.ok(facts, 'the verdict reads were prepared');
  for (const name of Object.keys(TABLE_READS)) assert.ok(seen.some(read => read.name === name), `the ${name} read ran while preparing`);
  assert.deepEqual(seen.filter(read => read.locked), [], 'no table read ran under the write lock while preparing');
  seen.length = 0;
  store.verify(f.board, prepared, { ...accept(f, prepared), verifyFacts: facts });
  assert.deepEqual(seen, [], 'the writer ran none of the table reads: it used the prepared ones');
  store.verify(f.board, plain, accept(f, plain));
  assert.ok(seen.some(read => read.name === 'history'), 'with nothing prepared the writer reads for itself');
  const strip = events => JSON.parse(JSON.stringify(events).replaceAll(`#${prepared}`, '#N').replaceAll(`#${plain}`, '#N'));
  assert.deepEqual(strip(verdictEvents(f, prepared)), strip(verdictEvents(f, plain)), 'the verdict events match the unprepared writer');
  assert.equal(store.getItem(f.board, prepared).item_status, 'verified');
});

test('store.io-board-verify.finish-preparation-wired: clause 3: PREPARATIONS.verify in write.js hands the prepared reads to the native verify through writeBoardCommand [C7,#10868]', t => {
  const f = fixture(t);
  const id = f.submitted('wired verdict');
  f.current();
  const seen = watchTableReads(f);
  const options = accept(f, id);
  store.writeBoardCommand(f.board, 'verify', [id, options], f.reviewer.id);
  for (const name of Object.keys(TABLE_READS)) assert.ok(seen.some(read => read.name === name), `the verdict read ${name}`);
  assert.deepEqual(seen.filter(read => read.locked), [], 'no table read ran while the write lock was held');
  assert.equal(seen.length, Object.keys(TABLE_READS).length, 'each table read ran once: the writer reused the prepared reads');
  assert.equal(store.getItem(f.board, id).item_status, 'verified');
});

test('store.io-board-verify.finish-waiter-wait: clause 2: a writer that waits on a verdict waits for its write, not for the table reads [C7,#10868]', async t => {
  const f = fixture(t);
  const READ_MS = 400;
  const id = f.submitted('waited-on verdict');
  f.current();
  const flags = new Int32Array(new SharedArrayBuffer(8)); // [0] the verdict reached its first table read, [1] the waiter is asking
  const waiter = new Worker(`const { DatabaseSync } = require('node:sqlite'); const { parentPort, workerData } = require('node:worker_threads');
    const db = new DatabaseSync(workerData.file); db.exec('PRAGMA busy_timeout = 60000'); const flags = workerData.flags;
    Atomics.wait(flags, 0, 0, 30000); Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
    const at = performance.now(); db.exec('BEGIN IMMEDIATE'); const waited = performance.now() - at; db.exec('ROLLBACK'); db.close();
    parentPort.postMessage(Math.round(waited));`, { eval: true, workerData: { file: f.file, flags } });
  t.after(() => waiter.terminate());
  const reported = new Promise((resolve, reject) => { waiter.once('message', resolve); waiter.once('error', reject); });
  await new Promise(resolve => waiter.once('online', resolve));
  // The first table read tells the waiter to ask for the lock, then takes READ_MS as a slow read on a loaded machine does.
  let first = true;
  const prepare = f.board.db.prepare.bind(f.board.db);
  f.board.db.prepare = sql => {
    if (first && Object.values(TABLE_READS).some(pattern => pattern.test(String(sql)))) {
      first = false;
      Atomics.store(flags, 0, 1);
      Atomics.notify(flags, 0);
      Atomics.wait(flags, 1, 0, 10000);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30 + READ_MS);
    }
    return prepare(sql);
  };
  store.writeBoardCommand(f.board, 'verify', [id, accept(f, id)], f.reviewer.id);
  const waitedMs = await reported;
  t.diagnostic(`verdict table read ${READ_MS} ms; waiter waited ${waitedMs} ms for the write lock`);
  assert.ok(Number.isFinite(waitedMs), 'the waiter reported its wait');
  // With the table reads under the lock the waiter waits at least READ_MS; prepared before it, at most half of that.
  assert.ok(waitedMs <= READ_MS / 2, `the waiter waited ${waitedMs} ms; the table read of ${READ_MS} ms must not sit inside the write lock`);
  assert.equal(store.getItem(f.board, id).item_status, 'verified');
});
