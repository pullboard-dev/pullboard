/** A land job for an item with a large proof stays under the job payload limit: its payload names ids, commits and refs, and the proof rides the request [C7,#7766]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { recordTestResults } from '../../../../../packages/store/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';

// The job payload cap the queue refuses above (JOB_PAYLOAD).
const PAYLOAD_LIMIT = 16384;
const COMMIT = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);

/** The board's ledger holding `count` proved test files at the item's commit, each with its own gate hit. */
function proveMany(board, count) {
  const rows = Array.from({ length: count }, (_, index) => ({ file: `packages/area${index % 40}/tests/io/some/deeper/case-${index}.test.js`,
    inputKey: index.toString(16).padStart(64, '0'), command: 'proof', context: 'c'.repeat(64), status: 'pass' }));
  assert.equal(recordTestResults(board.db, { receipt: 'gate:big#0', origin: 'pulled:r-gate', commit: COMMIT, rows }), count);
  return rows.map(row => row.file);
}

test('clause 2: a land job for an accepted item with a large proof is offered under 16384 bytes and the runner reads the proof from the job [C7,#7766]', async t => {
  const board = cellBoard(t, ':memory:');
  const files = proveMany(board, 900);
  const job = offerLandingJob(board.db, { items: [{ id: 7752, commit: COMMIT, ref: 'refs/pullboard/land/7752' }], expect: MAIN,
    config: { trunk: { remote: '/trunk.git' }, affectedTests: 'node bin/proof.mjs' } });
  const offered = JSON.parse(board.db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(job.id).job_step_payload).payload;
  assert.ok(Buffer.byteLength(JSON.stringify(offered)) < PAYLOAD_LIMIT, 'the payload fits the job payload limit');
  assert.equal(offered.proof, undefined, 'the proof is not in the payload');
  assert.deepEqual(offered.items, [{ id: 7752, commit: COMMIT, ref: 'refs/pullboard/land/7752' }]);
  assert.deepEqual(offered.requested, ['proof'], 'the payload names what moved to the request');
  const { claim } = jobQueueCall(board.db, { action: 'claim', runner: 'r-land', capabilities: [], kinds: ['land'] }, { mode: 'pull' });
  assert.equal(claim.job, job.id);
  const asked = jobQueueCall(board.db, { action: 'request', job: claim.job, runner: 'r-land', token: claim.token }, { mode: 'pull' });
  assert.deepEqual(asked.request.land.proof.files, files.slice().sort(), 'the runner reads every proved file from the request');
  assert.equal(asked.request.land.proof.runner, 'node bin/proof.mjs');
});

test('clause 1: a land job whose inputs are small keeps them in its payload and carries no request [C7,#7766]', t => {
  const board = cellBoard(t, ':memory:');
  proveMany(board, 3);
  const job = offerLandingJob(board.db, { items: [{ id: 1, commit: COMMIT }], expect: MAIN, config: { trunk: { remote: '/trunk.git' }, affectedTests: 'node bin/proof.mjs' } });
  const offered = JSON.parse(board.db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(job.id).job_step_payload);
  assert.equal(offered.payload.proof.files.length, 3);
  assert.equal(offered.payload.requested, undefined);
  assert.equal(offered.request, undefined);
});
