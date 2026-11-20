/** A posted gate or shard receipt writes one proof-ledger row per file it ran, keyed by inputKey and context class [P7,CD2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testResults } from '../../../store/index.js';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';

const HEAD = 'd'.repeat(40);
const GREEN = 'packages/gate/tests/io/test/action/memo.test.js';
const RED = 'packages/gate/tests/io/test/account/ledger.test.js';
const GREEN_KEY = '1'.repeat(64), RED_KEY = '2'.repeat(64), CONTEXT = 'e'.repeat(64);

/** Offer one job of a kind, claim it as a runner and post a receipt through the board API's queue, as a runner does. */
function postThrough(board, { id, kind, receipt }) {
  offerJob(board.db, { id, kind, needs: [], now: 1 });
  const held = claimJob(board.db, { runner: 'r-ledger', capabilities: [], now: 2 });
  return boardJobQueueCall(board, { action: 'receipt', job: id, runner: 'r-ledger', token: held.token, receipt }, { mode: 'pull', now: 3 });
}

test('api.ledger.after-pulled-gate-job-posts: clause 1: after one pulled gate job posts, the board holds one row per run file with its inputKey and context class, green files of a red job included [P7]', t => {
  // The ledger a runner's phaseLedger gives for a proof phase red in one file only (packages/gate/tests/io/test/account/phase.test.js).
  const ledger = { contexts: [CONTEXT], files: [[GREEN, GREEN_KEY, 0, 'pass'], [RED, RED_KEY, 0, 'fail']], omitted: 0 };
  const board = cellBoard(t, ':memory:');
  const job = 'gate:41:ledger';
  const posted = postThrough(board, { id: job, kind: 'gate', receipt: { version: 1, status: 1, gate: { source: HEAD, green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: RED, name: 'a failing case' }], ledger }] } } });
  assert.equal(posted.recorded, true);

  const rows = testResults(board.db, { receipt: `${job}#1` }).sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(rows.map(row => [row.file, row.inputKey, row.status]), [[RED, RED_KEY, 'fail'], [GREEN, GREEN_KEY, 'pass']], 'one row per run file at its inputKey');
  assert.ok(rows.every(row => row.context === CONTEXT), 'each row names its context class');
  assert.ok(rows.every(row => row.command === 'proof' && row.origin === 'pulled:r-ledger' && row.commit === HEAD), 'with its command class, origin and commit');
  assert.deepEqual(testResults(board.db, { inputKey: GREEN_KEY }).map(row => row.status), ['pass'], 'the green row is found by its inputKey');
});

test('api.ledger.shard-receipt-writes-files-too: clause 1: a shard receipt writes its files too [P7]', t => {
  const board = cellBoard(t, ':memory:');
  const key = 'a'.repeat(64), context = 'b'.repeat(64);
  const ledger = { contexts: [context], files: [['x.test.js', key, 0, 'pass'], ['y.test.js', key, 0, 'pass']], omitted: 0 };
  postThrough(board, { id: 'gate:42:shard:0', kind: 'gate-shard', receipt: { version: 1, status: 0, gate: { kind: 'shard', source: HEAD, green: true, phases: [{ role: 'proof', status: 0, ledger }] } } });
  assert.deepEqual(testResults(board.db, { inputKey: key }).map(row => [row.file, row.status, row.origin]).sort(), [['x.test.js', 'pass', 'shard:r-ledger'], ['y.test.js', 'pass', 'shard:r-ledger']]);
});
