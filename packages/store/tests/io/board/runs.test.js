/** The runs file opens beside the board behind a five-call port, and stays absent while runs_store is off [B2,P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../fixtures/cell.js';
import { cellSandbox } from '../../fixtures/cell.js';
import { writeBoardMeta } from '../../../src/io/board/meta.js';
import { RUNS_PORT_CALLS } from '../../../index.js';
import { boardRunsPort } from '../../../index.js';
import { openRunsStore } from '../../../index.js';
import { runsFilePath } from '../../../index.js';
import { runsPort } from '../../../index.js';
import { runsStoreOn } from '../../../index.js';
import { createJob } from '../../../../jobs/index.js';
import { jobView } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';

/** A board file path in a private scratch folder the sandbox removes after the test. */
function boardFile(t) {
  return join(cellSandbox(t).dir, 'board.sqlite');
}

test('the runs file opens in WAL with a busy timeout, the job tables and a runs_meta stamp naming its board [B2,P7]', t => {
  const file = runsFilePath(boardFile(t));
  const db = openRunsStore(file, { boardId: 'board-a' });
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.ok(db.prepare('PRAGMA busy_timeout').get().timeout > 0);
  const meta = Object.fromEntries(db.prepare('SELECT meta_key, meta_value FROM runs_meta').all().map(row => [row.meta_key, row.meta_value]));
  assert.deepEqual(meta, { board_id: 'board-a', schema: '1' });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('job', 'job_step')").all().map(row => row.name).sort();
  assert.deepEqual(tables, ['job', 'job_step']);
  assert.throws(() => openRunsStore(file, { boardId: 'board-b' }), error => error.code === 'RUNS_BOARD_MISMATCH', 'a runs file never serves a second board');
});

test('the runs port exposes only intend, confirm, cancel, receiptsSince and ack, and each is safe to repeat [B2,P7]', t => {
  const db = openRunsStore(':memory:', { boardId: 'board-a' });
  t.after(() => db.close());
  const port = runsPort({ db });
  assert.deepEqual(Object.keys(port), [...RUNS_PORT_CALLS]);
  assert.ok(Object.isFrozen(port));

  assert.equal(port.intend({ id: 'gate:1:abc:t', kind: 'gate', item: 1, request: { argv: ['x'] }, now: 10 }).written, true);
  assert.equal(port.intend({ id: 'gate:1:abc:t', kind: 'gate', item: 1, now: 11 }).written, false, 'a retried intent writes nothing');
  assert.equal(jobView(db, 'gate:1:abc:t').step, 'pending', 'an intended job is pending, never offered');
  assert.equal(port.confirm('gate:1:abc:t', { now: 12 }).written, true);
  assert.equal(port.confirm('gate:1:abc:t', { now: 13 }).written, false, 'a second confirm changes nothing');
  assert.equal(jobView(db, 'gate:1:abc:t').step, 'offered');

  writeStep(db, 'gate:1:abc:t', 'receipt', { attempt: 1 }, { seq: 1, now: 20 });
  const [receipt] = port.receiptsSince(0);
  assert.deepEqual({ job: receipt.job, attempt: receipt.attempt }, { job: 'gate:1:abc:t', attempt: 1 });
  assert.deepEqual(port.receiptsSince(receipt.cursor), [], 'the cursor moves past a read receipt');
  assert.equal(port.ack('gate:1:abc:t', 1, { now: 21 }).written, true);
  assert.equal(port.ack('gate:1:abc:t', 1, { now: 22 }).written, false, 'a repeated ack writes nothing');
  assert.deepEqual(port.receiptsSince(0), [], 'an acknowledged receipt is never handed back');

  port.intend({ id: 'land:2:k', kind: 'land', now: 30 });
  assert.equal(port.cancel('land:2:k', { now: 31 }).written, true);
  assert.equal(port.cancel('land:2:k', { now: 32 }).written, false, 'a second cancel changes nothing');
  assert.equal(port.cancel('missing', { now: 33 }).written, false);
});

test('with runs_store off a board makes no runs file and its job tables work as before; on, the file opens on first use [B2,P7]', t => {
  const file = boardFile(t);
  const board = cellBoard(t, file);
  assert.equal(runsStoreOn(board.db), false, 'the flag is off by default');
  assert.equal(boardRunsPort(board, file), null);
  createJob(board.db, { id: 'gate:9:def:t', kind: 'gate', item: 9, now: 1 });
  writeStep(board.db, 'gate:9:def:t', 'offered', {}, { now: 2 });
  assert.equal(jobView(board.db, 'gate:9:def:t').step, 'offered', 'job rows still live on the board while the flag is off');
  assert.equal(existsSync(runsFilePath(file)), false, 'no runs file while the flag is off');

  writeBoardMeta(board.db, 'runs_store', '1');
  const port = boardRunsPort(board, file);
  assert.ok(port, 'the flag on hands back a port');
  assert.equal(existsSync(runsFilePath(file)), false, 'the runs file opens lazily, on the first call');
  port.intend({ id: 'gate:9:ghi:t', kind: 'gate', item: 9, now: 3 });
  assert.equal(existsSync(runsFilePath(file)), true);
  assert.equal(jobView(board.db, 'gate:9:ghi:t'), null, 'a port call never writes the board');
});
