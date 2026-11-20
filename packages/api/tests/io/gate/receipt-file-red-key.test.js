/** A gate receipt's file that fails as a whole carries its input key, so the board compares that red with main [C7,P7,CD2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { createJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';
import { mainRedFileExcuse } from '../../../src/io/gate/main-red-files.js';

const CRASHED = 'web/crashed.test.js';
const KEY = 'a'.repeat(64), OTHER_KEY = 'b'.repeat(64);

/** A finished main-test job holding main's keyed receipt for CRASHED at `inputKey`. */
function mainReceipt(board, { inputKey = KEY, verdict = 'red' } = {}) {
  const id = `main-test:${verdict}-${inputKey.slice(0, 4)}`, main = 'c'.repeat(40);
  createJob(board.db, { id, kind: 'main-test', candidate: main, base: main, now: 5 });
  writeStep(board.db, id, 'receipt', { id, tree: 't'.repeat(40), file: CRASHED, command: 'node --test', verdict, failing: [], signatures: [], main, at: 5, inputKey }, { seq: 0, now: 5 });
}

/** A red proof receipt whose file threw on import: no case is named, only the spec footer's failed-file list, and the ledger keys the file. */
const wholeFileRed = key => ({ version: 1, status: 1, gate: { source: 'd'.repeat(40), green: false,
  phases: [{ role: 'proof', status: 1, failures: null, failedFiles: [CRASHED], tail: 'not ok', ledger: { contexts: ['node'], files: [[CRASHED, key, 0, 'fail']] } }] } });

test('api.gate.receipt-file-red-key.whole-file-red-compares-with-main: clause 1: a file that fails as a whole is excused when main is red at the same input key [C7]', t => {
  const board = cellBoard(t, ':memory:');
  mainReceipt(board);
  const excused = mainRedFileExcuse(board, wholeFileRed(KEY));
  assert.deepEqual(excused?.map(row => [row.file, row.inputKey, row.verdict]), [[CRASHED, KEY, 'red']], 'the whole-file red is compared with main at its key');
});

test('api.gate.receipt-file-red-key.whole-file-red-otherwise-unexcused: clause 1: a whole-file red with no keyed row, or main red only at another key, is not excused [C7]', t => {
  const board = cellBoard(t, ':memory:');
  mainReceipt(board, { inputKey: OTHER_KEY });
  assert.equal(mainRedFileExcuse(board, wholeFileRed(KEY)), null, 'main measured another key');
  const keyless = wholeFileRed(KEY);
  delete keyless.gate.phases[0].ledger;
  assert.equal(mainRedFileExcuse(board, keyless), null, 'no input key, no excuse');
  const nameless = wholeFileRed(KEY);
  nameless.gate.phases[0].failedFiles = [];
  assert.equal(mainRedFileExcuse(board, nameless), null, 'a red naming neither a case nor a file is not excused');
});
