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
import { closeCellBoard } from '../../fixtures/cell.js';
import { openCellBoard } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';
import {
  beginImmediateQueued,
  boardWriteHolderText,
  configureBoardJournal,
  prepareBoardWriteIdentity,
} from '../../../index.js';

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

test('a board write lands in under 1 s past stale holder records, a long reader and a busy gate worker [C7]', { timeout: 60_000 }, async t => {
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
