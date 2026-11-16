/** With runs_store on, the submit hand-off record lives on the gate job's run row, written in the move and read from there [B2,M3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../fixtures/cell.js';
import { writeBoardMeta } from '../../../../src/io/board/meta.js';
import { handoffRecord } from '../../../../index.js';
import { handoffRecords } from '../../../../index.js';
import { saveSubmitHandoff as recordSubmitHandoff } from '../../../../index.js';
import { jobView } from '../../../../../jobs/index.js';

const record = (id, state, extra = {}) => ({ version: 1, id, agentId: 'core-1', commit: 'c'.repeat(40), main: 'd'.repeat(40), digest: 'x', state, ...extra });
const runRow = (board, job) => board.db.prepare('SELECT * FROM run WHERE run_job = ?').get(job);

test('clause 1: with runs_store on, the submit hand-off record is written to run.run_record inside the same move [B2,M3]', t => {
  const board = cellBoard(t, ':memory:');
  writeBoardMeta(board.db, 'runs_store', '1');
  board.db.exec('BEGIN IMMEDIATE');
  recordSubmitHandoff(board.db, 5, record('gate:5:a', 'queued'));
  board.db.exec('ROLLBACK');
  assert.equal(runRow(board, 'gate:5:a'), undefined, 'a rolled-back move leaves no record');
  board.db.exec('BEGIN IMMEDIATE');
  recordSubmitHandoff(board.db, 5, record('gate:5:a', 'queued'));
  recordSubmitHandoff(board.db, 5, record('gate:5:a', 'running'));
  board.db.exec('COMMIT');
  const row = runRow(board, 'gate:5:a');
  assert.equal(row.run_kind, 'gate');
  assert.equal(row.run_item, 5);
  assert.equal(JSON.parse(row.run_record).state, 'running', 'a later save replaces the record on the same row');
  assert.equal(jobView(board.db, 'gate:5:a'), null, 'no job step is written to the board');
});

test('clause 2: with runs_store on, grant and handoff records read the record from run.run_record [B2,M3]', t => {
  const board = cellBoard(t, ':memory:');
  writeBoardMeta(board.db, 'runs_store', '1');
  recordSubmitHandoff(board.db, 5, record('gate:5:a', 'red'));
  recordSubmitHandoff(board.db, 5, record('gate:5:b', 'queued'));
  recordSubmitHandoff(board.db, 6, record('gate:6:a', 'running'));
  assert.equal(handoffRecord(board.db, 5).id, 'gate:5:b', 'the newest record is the item\'s current one');
  assert.equal(handoffRecord(board.db, 7), undefined);
  assert.deepEqual([...handoffRecords(board.db)].map(([item, found]) => [item, found.id]).sort(), [[5, 'gate:5:b'], [6, 'gate:6:a']]);
});

test('clause 3: with runs_store off, the record is written and read where it is today [B2,M3]', t => {
  const board = cellBoard(t, ':memory:');
  recordSubmitHandoff(board.db, 5, record('gate:5:a', 'queued'));
  assert.equal(runRow(board, 'gate:5:a'), undefined, 'no run row while the flag is off');
  assert.equal(jobView(board.db, 'gate:5:a').step, 'queued', 'the record is a job step as before');
  assert.equal(handoffRecord(board.db, 5).state, 'queued');
  writeBoardMeta(board.db, 'runs_store', '1');
  assert.equal(handoffRecord(board.db, 5), undefined, 'turning the flag on reads run rows only');
});
