/** A submit settles under pull with no dispatcher row on the board: a runner pulls the gate job and its green receipt submits the item [C7,#8172]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { headTree } from '../../../../git/index.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { postReceipt } from '../../../index.js';

/** The kinds of every job row the board holds, sorted. */
function jobKinds(board) {
  return board.db.prepare('SELECT job_kind AS kind FROM job ORDER BY job_kind').all().map(row => row.kind);
}

test('api.gate-pull-settles.gate-offered-pull-job-settles: a gate offered as a pull job settles the submit with no dispatcher row on the board [C7,#8172]', t => {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const tree = headTree(repo.root);
  const job = `gate:${item.item_id}:pull`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  assert.deepEqual(jobKinds(board), ['gate'], 'the offer adds the gate job and no dispatcher row');
  const lease = claimJob(board.db, { runner: 'r-pull', capabilities: [], now: 2 });
  assert.equal(lease?.job, job, 'the runner pulls the offered gate');
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-pull', token: lease.token,
    receipt: { version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } } }, { mode: 'pull', now: 3 });
  assert.equal(posted.applied.outcome, 'review', JSON.stringify(posted.applied));
  const after = store.getItem(board, item.item_id);
  assert.equal(after.item_status, 'submitted');
  assert.equal(after.item_commit, head);
  assert.ok(!jobKinds(board).includes('dispatcher'), 'no dispatcher row appeared while the submit settled');
});

/** Budget: a gate receipt past the jobs store's 64 KiB blob threshold, as a 300-file sharded gate's is (#10181). */
const BLOB_BYTES = 64 * 1024;

/**
 * A claimed item whose gate job a runner holds and answers with a passed check that leaves its proof to two shards. The
 * receipt names 2000 proof files in its analysis, so it posts in parts (receiptPart, #10771) and the board keeps it as a
 * blob stub; its apply offers the shard jobs.
 */
function shardedGate(t, tag) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const job = `gate:${item.item_id}:${tag}`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree: headTree(repo.root), files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  assert.equal(lease?.job, job, 'the runner pulls the offered gate');
  const proofFiles = Array.from({ length: 2000 }, (_, n) => `web/tests/io/sharded/receipt/case-${n}.test.js`);
  const gate = { version: 1, source: head, green: false, deferred: true, phases: [{ role: 'check', status: 0 }], analysis: { proofFiles },
    proofPlan: { runner: 'node --test', cores: 2, files: ['web/a.test.js', 'web/b.test.js', 'web/c.test.js', 'web/d.test.js'] } };
  const text = JSON.stringify(gate), size = 32 * 1024, count = Math.ceil(text.length / size);
  assert.ok(Buffer.byteLength(text) > BLOB_BYTES, 'the gate receipt is over the blob threshold');
  const call = body => boardJobQueueCall(board, { job, runner: 'r-gate', token: lease.token, ...body }, { mode: 'pull', now: 3 });
  for (let index = 0; index < count; index += 1) call({ action: 'receiptPart', part: { index, count, text: text.slice(index * size, (index + 1) * size) } });
  const posted = call({ action: 'receipt', receipt: { status: 0, gateParts: { count, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') } } });
  assert.equal(posted.applied.outcome, 'sharded', JSON.stringify(posted.applied));
  const stored = board.db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt'").get(job).payload;
  assert.ok(JSON.parse(stored).blob, 'the board keeps the joined gate receipt as a blob stub');
  return { board, item, head, job, shards: posted.applied.shards };
}

/** A runner pulls one shard job and posts its green proof: through the board's jobs route, or with lost set, recorded alone, so no apply runs. */
function postShard(board, shard, head, at, { lost = false } = {}) {
  const lease = claimJob(board.db, { runner: `r-${at}`, capabilities: [], now: at });
  assert.equal(lease?.job, shard, 'the runner pulls the next shard');
  const receipt = { version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } };
  const body = { job: shard, runner: `r-${at}`, token: lease.token, receipt };
  return lost ? postReceipt(board.db, { ...body, now: at + 1 }) : boardJobQueueCall(board, { action: 'receipt', ...body }, { mode: 'pull', now: at + 1 });
}

test('api.gate-pull-settles.blob-receipt-shards-settle: clause 1: a sharded gate whose receipt the board keeps as a blob stub settles its item when the last shard posts [C7,P7,#10181]', t => {
  const { board, item, head, shards } = shardedGate(t, 'blob');
  assert.equal(shards.length, 2);
  assert.equal(postShard(board, shards[0], head, 10).applied.outcome, 'waiting');
  const last = postShard(board, shards[1], head, 20);
  assert.equal(last.applied.outcome, 'review', JSON.stringify(last.applied));
  assert.equal(store.getItem(board, item.item_id).item_status, 'submitted');
});

test('api.gate-pull-settles.lost-shard-apply-reconciles: clause 2: a sharded gate whose last apply was lost settles on the next runner claim, and only once [C7,P7,#10181]', t => {
  const { board, item, head, job, shards } = shardedGate(t, 'lost');
  postShard(board, shards[0], head, 10);
  assert.equal(postShard(board, shards[1], head, 20, { lost: true }).recorded, true, 'the last shard is recorded');
  assert.equal(store.getItem(board, item.item_id).item_status, 'claimed', 'with its apply lost the item still waits');
  const events = () => board.db.prepare('SELECT COUNT(*) AS n FROM event WHERE item_id = ?').get(item.item_id).n;
  boardJobQueueCall(board, { action: 'claim', runner: 'r-next', capabilities: [] }, { mode: 'pull', now: 30 });
  assert.equal(store.getItem(board, item.item_id).item_status, 'submitted', 'the claim settled the item');
  const settled = events();
  boardJobQueueCall(board, { action: 'claim', runner: 'r-next', capabilities: [] }, { mode: 'pull', now: 40 });
  assert.equal(events(), settled, 'a second claim applies nothing again');
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ? AND job_step_name = 'note:shards.settled'").get(job).n, 1);
});
