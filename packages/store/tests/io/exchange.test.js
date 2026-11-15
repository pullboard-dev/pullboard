/** Board exports without the additive job tables still import; every other table still matches exactly [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import {
  exportBoard,
  importBoard,
} from '../../index.js';

/** Export a board as a fresh copy that drops the job tables and their counter, like an export made before them. */
function exportWithoutJobTables(board) {
  const document = exportBoard(board);
  delete document.tables.job;
  delete document.tables.job_step;
  if (Array.isArray(document.tables.sqlite_sequence)) {
    document.tables.sqlite_sequence = document.tables.sqlite_sequence.filter(({ name }) => name !== 'job_step');
  }
  return document;
}

/** Write one job and one step row straight into the board's job tables. */
function seedJob(board) {
  board.db.prepare('INSERT INTO job (job_id, job_kind, job_item, job_step, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?)')
    .run('job-1', 'gate', 7, 'running', 1000, 2000);
  board.db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, ?, ?, ?)')
    .run('job-1', 'dispatch', 0, '{"runner":"r1"}', 1500);
}

/** Read both job tables in a stable order. */
function jobRows(board) {
  return {
    job: board.db.prepare('SELECT * FROM job ORDER BY job_id').all().map((row) => ({ ...row })),
    job_step: board.db.prepare('SELECT * FROM job_step ORDER BY job_step_id').all().map((row) => ({ ...row })),
  };
}

test('clause 1: an export without the job tables imports into a board that has them [C7]', (t) => {
  const source = fixtureBoard(t);
  const document = exportWithoutJobTables(source);
  assert.equal(Object.hasOwn(document.tables, 'job'), false);
  const target = fixtureBoard(t);
  const result = importBoard(target, document);
  assert.equal(result.tables.includes('job') || result.tables.includes('job_step'), false, 'the import reports only tables the export carried, so left-out job tables are not listed');
  assert.ok(target.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('job','job_step')").all().length === 2, 'the target board has the job tables');
  assert.deepEqual(jobRows(target), { job: [], job_step: [] }, 'the left-out job tables import as empty');
});

test('clause 1: an export missing any other table, or with an extra table, still refuses IMPORT_SCHEMA [C7]', (t) => {
  const source = fixtureBoard(t);
  const missing = exportWithoutJobTables(source);
  delete missing.tables.item;
  assert.throws(() => importBoard(fixtureBoard(t), missing), (error) => error.code === 'IMPORT_SCHEMA');
  const extra = exportWithoutJobTables(source);
  extra.tables.not_a_board_table = [];
  assert.throws(() => importBoard(fixtureBoard(t), extra), (error) => error.code === 'IMPORT_SCHEMA');
});

test('clause 2: an export from a board with job tables round-trips [C7]', (t) => {
  const source = fixtureBoard(t);
  seedJob(source);
  const document = exportBoard(source);
  assert.equal(document.tables.job.length, 1);
  assert.equal(document.tables.job_step.length, 1);
  const target = fixtureBoard(t);
  importBoard(target, document);
  assert.deepEqual(jobRows(target), jobRows(source), 'job and job_step rows survive export and import');
});

test('clause 1: an empty-job export lists no job tables [C7]', (t) => {
  const source = fixtureBoard(t);
  const document = exportBoard(source);
  assert.equal(Object.hasOwn(document.tables, 'job'), false, 'an empty job table is left out');
  assert.equal(Object.hasOwn(document.tables, 'job_step'), false, 'an empty job_step table is left out');
  assert.equal((document.tables.sqlite_sequence ?? []).some(({ name }) => name === 'job' || name === 'job_step'), false, 'no counter for a left-out table');
  const target = fixtureBoard(t);
  importBoard(target, document);
  assert.deepEqual(jobRows(target), { job: [], job_step: [] }, 'the export still imports into a board that has the job tables');
});
