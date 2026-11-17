/** With runs_store on, the gate-shard and land-shard offers go through queueRun: the runs file holds each shard and the board one queued run row per shard; off, the board's job rows are as before [B2,P7,#9005]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { cellSandbox } from '../../../store/tests/fixtures/cell.js';
import { boardRun } from '../../../store/index.js';
import { RUNS_STORE_KEY } from '../../../store/index.js';
import { jobView } from '../../../jobs/index.js';
import { SHARD_JOB_KIND } from '../../index.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';
import { queueFor } from '../../index.js';
import { offerProofShards } from '../../src/io/gate.js';

const MAIN = 'a'.repeat(40), MERGED = 'b'.repeat(40);
const FILES = ['web/a.test.js', 'web/b.test.js', 'web/c.test.js'];
const GATE = { run: ['node', '-e', 'x'], entry: 'gate.js', commits: [MAIN] };

/** A file board with the runs_store flag set as asked, and its queue (null when off). */
function boardWith(t, flag) {
  const dir = cellSandbox(t).dir;
  const board = cellBoard(t, join(dir, 'board.sqlite'), undefined, { real: true });
  board.seat = cellSeat(board, { lane: 'web', path: join(dir, 'seat') });
  if (flag) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1');
  const queue = queueFor(board, 'coordinator');
  t.after(() => queue?.runs.db.close());
  return { board, queue, home: queue ? queue.runs.db : board.db };
}

/** A gate job offered (queued when the flag is on), then its receipt's proof plan sharded two files to a core. */
function shardedGate(t, flag) {
  const { board, queue, home } = boardWith(t, flag);
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  offerJob(board.db, { id: 'gate:s', kind: 'gate', item: item.item_id, candidate: MAIN, base: MAIN, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} } } }, queue);
  const receipt = { version: 1, status: 0, gate: { source: MAIN, green: true, phases: [], proofPlan: { runner: 'node --test', cores: 2, files: FILES } } };
  const offered = { item: item.item_id, candidate: MAIN, main: MAIN, submit: { agentId: board.seat.id } };
  return { board, home, answer: offerProofShards(board, { job: 'gate:s', receipt, offered }) };
}

/** A land job offered (queued when the flag is on) and claimed from where it lives, then its proof sharded through the board's jobs route. */
function shardedLand(t, flag) {
  const { board, queue, home } = boardWith(t, flag);
  offerJob(board.db, { id: 'land:1:k', kind: 'land', base: MAIN, needs: [], now: 4 }, queue);
  const held = claimJob(home, { runner: 'r-land', capabilities: [], now: 5 });
  const answer = boardJobQueueCall(board, { action: 'shards', job: 'land:1:k', runner: 'r-land', token: held.token, merged: MERGED,
    plan: { runner: 'node --test', files: FILES, cores: 1 }, gate: GATE }, { mode: 'pull', now: 6 });
  return { board, home, answer };
}

test('api.shard-queue.runs-store-gate-shard-offer: clause 1: with runs_store on, the gate-shard offer goes through queueRun and each shard has a queued run row [B2,P7]', t => {
  const { board, home, answer } = shardedGate(t, true);
  assert.deepEqual(answer.shards, ['gate:s:shard:1', 'gate:s:shard:2']);
  for (const id of answer.shards) {
    assert.equal(boardRun(board.db, id).run_state, 'queued');
    assert.equal(boardRun(board.db, id).run_kind, SHARD_JOB_KIND);
    assert.equal(jobView(home, id).step, 'offered', 'the runs file holds the offered shard');
  }
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM job WHERE job_kind = ?").get(SHARD_JOB_KIND).n, 0, 'the board writes no shard job row');
});

test('api.shard-queue.runs-store-land-proof-shard: clause 2: with runs_store on, the land-proof shard offer goes through queueRun and each shard has a queued run row [B2,P7]', t => {
  const { board, home, answer } = shardedLand(t, true);
  assert.deepEqual(answer, { sharded: true, shards: [1, 2, 3].map(n => `land:1:k:shard:${n}`) });
  for (const id of answer.shards) {
    assert.equal(boardRun(board.db, id).run_state, 'queued');
    assert.equal(jobView(home, id).step, 'offered');
  }
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM job WHERE job_kind = ?").get(SHARD_JOB_KIND).n, 0, 'the board writes no shard job row');
});

test('api.shard-queue.runs-store-off-both-shard: clause 3: with runs_store off, both shard offers write the same board job rows as on main and no run row [B2,P7]', t => {
  const gate = shardedGate(t, false), land = shardedLand(t, false);
  assert.deepEqual(gate.answer.shards, ['gate:s:shard:1', 'gate:s:shard:2']);
  assert.deepEqual(land.answer.shards, [1, 2, 3].map(n => `land:1:k:shard:${n}`));
  for (const { board, answer } of [gate, land]) {
    for (const id of answer.shards) assert.equal(jobView(board.db, id).step, 'offered');
    assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM run').get().n, 0);
  }
});
