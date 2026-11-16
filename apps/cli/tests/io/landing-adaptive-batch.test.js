/** landing.adaptiveBatch: off, the batch cap is the line setting as before; on, it grows with clean batches and resets on a stop [C7,#9017]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { adaptiveBatchSize } from '../../src/io/landing/adaptive.js';
import { batchCap } from '../../src/io/landing/adaptive.js';

/** A board stub holding a real in-memory database: the line setting and finished landing runs, oldest first. */
function board({ size = null, outcomes = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT); CREATE TABLE run (run_job TEXT PRIMARY KEY, run_kind TEXT, run_outcome TEXT, run_updated INTEGER)');
  if (size !== null) db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('line_setting:landingBatchSize', JSON.stringify(size));
  outcomes.forEach((outcome, i) => db.prepare('INSERT INTO run VALUES (?, ?, ?, ?)').run(`land:${i}`, 'land', outcome, i));
  return { db };
}

test('clause 1: with landing.adaptiveBatch off, batchCap returns the line.landingBatchSize cap or no cap, whatever the history [C7,#9017]', () => {
  const landed = Array(9).fill('landed');
  assert.equal(batchCap(board({ outcomes: landed })), Infinity);
  assert.equal(batchCap(board({ size: 3, outcomes: landed })), 3);
  assert.equal(batchCap(board({ size: 3, outcomes: ['red'] }), { adaptive: false }), 3);
});

test('clause 2: with landing.adaptiveBatch on, the size starts at 1 and rises by one after 3 clean batches in a row, never past line.landingBatchSize [C7,#9017]', () => {
  assert.equal(batchCap(board(), { adaptive: true }), 1);
  assert.equal(batchCap(board({ outcomes: ['landed', 'landed'] }), { adaptive: true }), 1);
  assert.equal(batchCap(board({ outcomes: Array(3).fill('landed') }), { adaptive: true }), 2);
  assert.equal(batchCap(board({ outcomes: Array(6).fill('landed') }), { adaptive: true }), 3);
  assert.equal(batchCap(board({ size: 2, outcomes: Array(30).fill('landed') }), { adaptive: true }), 2);
  assert.equal(adaptiveBatchSize(Array(9).fill(true), 3), 3);
});

test('clause 3: with landing.adaptiveBatch on, any stopped batch drops the next size back to 1 [C7,#9017]', () => {
  assert.equal(batchCap(board({ outcomes: [...Array(6).fill('landed'), 'red'] }), { adaptive: true }), 1);
  assert.equal(batchCap(board({ outcomes: [...Array(6).fill('landed'), 'conflict', 'landed', 'landed', 'landed'] }), { adaptive: true }), 2);
});
