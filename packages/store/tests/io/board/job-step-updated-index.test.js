/** @pullboard-test-input source-cell store */
/** The job table has a job_step_updated index so the finished-runs count is a range read [C7,#6722]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { closeBoard } from '../../../index.js';
import { openKitBoard } from '../../fixtures/cell.js';
import { temporaryDirectory } from '../../fixtures/tmp.js';

const QUERY = "SELECT job_kind, COUNT(*) FROM job WHERE job_step = 'done' AND job_updated > ? GROUP BY job_kind";

/** Index columns of one index in a board file, read without pullboard. */
function indexColumns(file, name) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(`PRAGMA index_info(${name})`).all().map(entry => entry.name); } finally { db.close(); }
}

/** The query plan detail lines for the finished-runs count. */
function plan(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(`EXPLAIN QUERY PLAN ${QUERY}`).all(0).map(row => row.detail).join('\n'); } finally { db.close(); }
}

/** A real board file in a temporary folder. */
function boardFile(t) {
  const directory = temporaryDirectory('pullboard-job-step-updated-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board.sqlite');
  closeBoard(openKitBoard(file));
  return file;
}

/** Asserts the index exists with its three columns and the plan uses it without a table scan. */
function assertIndexed(file) {
  assert.deepEqual(indexColumns(file, 'job_step_updated'), ['job_step', 'job_updated', 'job_kind']);
  const detail = plan(file);
  assert.match(detail, /job_step_updated/);
  assert.doesNotMatch(detail, /SCAN job\b/);
}

test('store.io-board-job-step-updated-index.a-fresh-board-has-the-job: clause 1: a fresh board has the job_step_updated index and the finished-runs count uses it [C7]', t => {
  assertIndexed(boardFile(t));
});

test('store.io-board-job-step-updated-index.a-board-that-predates-the-index: clause 1: a board that predates the index gains it on open and the count uses it [C7]', t => {
  const file = boardFile(t);
  const old = new DatabaseSync(file);
  try { old.exec('DROP INDEX job_step_updated'); } finally { old.close(); }
  assert.deepEqual(indexColumns(file, 'job_step_updated'), []);
  closeBoard(openKitBoard(file));
  assertIndexed(file);
});
