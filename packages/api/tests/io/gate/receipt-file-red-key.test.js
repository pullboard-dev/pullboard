/** A gate receipt keeps the input key of a file that fails as a whole, so the board can compare that red with main [C7,P7,CD2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testResults } from '../../../../store/index.js';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { phaseLedger } from '../../../../gate/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';

const HEAD = 'd'.repeat(40);
const GREEN = 'packages/gate/tests/io/test/action/memo.test.js';
const CRASHED = 'packages/gate/tests/io/test/account/ledger.test.js';
const GREEN_KEY = '1'.repeat(64), CRASHED_KEY = '2'.repeat(64), CONTEXT = 'e'.repeat(64);

/** The per-file frames a run prints for two keyed files, as the test cache writes them. */
const FRAMES = [[GREEN, GREEN_KEY], [CRASHED, CRASHED_KEY]]
  .map(([file, inputKey]) => `# pullboard test cache ${JSON.stringify({ file, outcome: 'ran', key: 'c'.repeat(64), missed: null, inputKey, context: CONTEXT })}`).join('\n');

test('api.gate.receipt-file-red-key.whole-file-red-keeps-its-key: clause 1: a file that fails as a whole gets a gate receipt row at the key a passing run carries [C7]', t => {
  // The file threw on import, so the run names no case: only the spec footer's failed-file list says which file failed.
  const ledger = phaseLedger(FRAMES, { status: 1, failures: null, failedFiles: [CRASHED] });
  assert.ok(ledger, 'a red phase naming a failed file gives a ledger');
  const board = cellBoard(t, ':memory:');
  const job = 'gate:51:file-red';
  offerJob(board.db, { id: job, kind: 'gate', needs: [], now: 1 });
  const held = claimJob(board.db, { runner: 'r-file-red', capabilities: [], now: 2 });
  const phase = { role: 'proof', status: 1, failures: null, failedFiles: [CRASHED], ledger };
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-file-red', token: held.token, receipt: { version: 1, status: 1, gate: { source: HEAD, green: false, phases: [phase] } } }, { mode: 'pull', now: 3 });
  assert.equal(posted.recorded, true);
  const rows = testResults(board.db, { receipt: `${job}#1` }).sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(rows.map(row => [row.file, row.inputKey, row.status]), [[CRASHED, CRASHED_KEY, 'fail'], [GREEN, GREEN_KEY, 'pass']], 'the crashed file fails at its own key, the other file passes');
});

test('api.gate.receipt-file-red-key.no-named-file-no-row: clause 1: a red phase that names neither a case nor a file writes no row [C7]', () => {
  assert.equal(phaseLedger(FRAMES, { status: 1, failures: null, failedFiles: [] }), null, 'no row is guessed');
});
