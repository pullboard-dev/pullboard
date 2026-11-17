/** show and trace read run outcomes from the board's run rows and live steps from a read-only runs handle while runs_store is on, as on main when off [B2,#9013]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../packages/store/tests/fixtures/cell.js';
import { applyReceipts } from '../../../../packages/store/index.js';
import { boardRunsHolder } from '../../../../packages/store/index.js';
import { boardRunsReader } from '../../../../packages/store/index.js';
import { queueRun } from '../../../../packages/store/index.js';
import { runsPort } from '../../../../packages/store/index.js';
import { RUNS_STORE_KEY } from '../../../../packages/store/index.js';
import { claimJob } from '../../../../packages/api/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { postReceipt } from '../../../../packages/api/index.js';
import { newestGateJob } from '../../src/io/commands/show.js';
import { readJobSteps } from '../../src/io/trace.js';

const COMMIT = 'c'.repeat(40);
const JOB = 'gate:9013:one';
const RECEIPT = { version: 1, status: 0, outcome: 'green', gate: { source: COMMIT, green: true, phases: [{ role: 'proof', status: 0 }] } };

/** A file board with the flag as asked, and one gate for item 9013 queued and, when `settle`, claimed, receipted and applied. */
function boardWith(t, flag, { settle = true } = {}) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  if (!flag) {
    offerJob(board.db, { id: JOB, kind: 'gate', item: 9013, candidate: COMMIT, base: COMMIT, now: 1 });
    if (settle) postReceipt(board.db, { job: JOB, runner: 'r1', token: claimJob(board.db, { runner: 'r1', capabilities: [], now: 2 }).token, receipt: RECEIPT, now: 3 });
    return { board, file: repo.boardFile, runs: null };
  }
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1');
  const holder = boardRunsHolder(board, repo.boardFile);
  t.after(() => holder.db.close());
  queueRun(board, runsPort(holder), { by: 'coordinator', id: JOB, kind: 'gate', item: 9013, candidate: COMMIT, base: COMMIT });
  if (settle) {
    const lease = claimJob(holder.db, { runner: 'r1', capabilities: [], now: Date.now() });
    postReceipt(holder.db, { job: JOB, runner: 'r1', token: lease.token, receipt: RECEIPT, now: Date.now() });
    applyReceipts(board, holder, runsPort(holder), { by: 'coordinator' });
  }
  return { board, file: repo.boardFile, runs: boardRunsReader(board, repo.boardFile) };
}

test('clause 1: with runs_store on, show takes the gate outcome from the board run row and the live step from a read-only runs handle [B2,#9013]', t => {
  const { board, runs } = boardWith(t, true);
  t.after(() => runs.db?.close());
  const job = newestGateJob(board.db, 9013, [], { runs });
  assert.equal(job.id, JOB);
  assert.equal(job.step, 'done');
  assert.equal(job.outcome, 'green', 'the outcome is the board run row\'s');
  assert.equal(job.gate.green, true, 'the receipt is read back from the runs file');
  assert.throws(() => runs.db.exec('CREATE TABLE x (y)'), /readonly/u, 'the handle is read-only');
  // A queued gate shows the runs file's live step, and a missing runs file still answers from the board.
  const queued = boardWith(t, true, { settle: false });
  t.after(() => queued.runs.db?.close());
  assert.equal(newestGateJob(queued.board.db, 9013, [], { runs: queued.runs }).step, 'offered');
  assert.equal(newestGateJob(queued.board.db, 9013, [], { runs: { db: null } }).step, 'queued');
});

test('clause 2: with runs_store on, trace lists the live job steps from the runs file and one outcome step from the board run row [B2,#9013]', t => {
  const { board, runs } = boardWith(t, true);
  t.after(() => runs.db?.close());
  const rows = readJobSteps(board.db, { runs });
  assert.deepEqual(rows.filter(row => row.item === 9013).map(row => `${row.kind}:${row.step}`).filter(name => /outcome|offered|receipt/u.test(name)).sort(),
    ['gate:offered', 'gate:outcome:green', 'gate:receipt']);
  assert.deepEqual(readJobSteps(board.db, { runs: { db: null } }).map(row => row.step), ['outcome:green']);
  assert.deepEqual(board.db.prepare('SELECT job_id FROM job').all(), [], 'the board holds no job rows');
});

test('clause 3: with runs_store off, show and trace read the board job rows as on main [B2,#9013]', t => {
  const { board } = boardWith(t, false);
  const job = newestGateJob(board.db, 9013, []);
  assert.deepEqual(newestGateJob(board.db, 9013, [], { runs: null }), job);
  assert.equal(job.id, JOB);
  assert.equal(job.step, 'done');
  assert.equal('outcome' in job, false);
  const rows = readJobSteps(board.db);
  assert.deepEqual(readJobSteps(board.db, { runs: null }), rows);
  assert.ok(rows.some(row => row.step === 'receipt'));
  assert.equal(boardRunsReader(board, 'unused'), null, 'no reader is made while the flag is off');
});
