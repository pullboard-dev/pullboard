/** The board withdraws a land job's unfinished shards when the land job ends, and a re-offered land job never reuses an earlier tree's shards [C7,#7818,#8198]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { jobRequest } from '../../index.js';
import { jobViews } from '../../index.js';
import { offerJob } from '../../index.js';

const MAIN = 'a'.repeat(40), FIRST = 'b'.repeat(40), SECOND = 'c'.repeat(40);
const FILES = Array.from({ length: 7 }, (_, at) => `packages/x/tests/f${at + 1}.test.js`);
const GATE = { run: ['node', '-e', 'x'], entry: 'gate.js', commits: [MAIN] };
const REF = 'refs/pullboard/landing/land-1-k';
const OPTIONS = { mode: 'pull' };

/** A board with one claimed land job; `shards(merged)` asks for its proof's shards, `end()` posts the land job's receipt. */
function landing(t) {
  const board = cellBoard(t, ':memory:');
  offerJob(board.db, { id: 'land:1:k', kind: 'land', base: MAIN, needs: [], now: 1 });
  const held = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 2 });
  const call = (body, now) => boardJobQueueCall(board, { job: 'land:1:k', runner: 'r-land', token: held.token, ...body }, { ...OPTIONS, now });
  return { board, held,
    shards: (merged, extra = {}, now = 3) => call({ action: 'shards', merged, ref: REF, plan: { runner: 'node --test', files: FILES, cores: 2 }, gate: GATE, ...extra }, now),
    receipts: (ids, now = 4) => call({ action: 'shardReceipts', shards: ids }, now),
    end: (now = 10) => call({ action: 'receipt', receipt: { kind: 'land', outcome: 'red' } }, now) };
}

/** Claim one shard as a runner and post its receipt. */
function postShard(board, runner, now) {
  const claim = claimJob(board.db, { runner, capabilities: [], now });
  boardJobQueueCall(board, { action: 'receipt', job: claim.job, runner, token: claim.token, receipt: { version: 1, status: 0, gate: { green: true, phases: [{ role: 'proof', status: 0 }] } } }, { ...OPTIONS, now: now + 1 });
  return claim.job;
}

test('clause 2: when the land job posts its receipt, every unfinished shard ends, even one a runner holds, and none is claimed again [test] [C7,#7818]', t => {
  const { board, shards, end } = landing(t);
  const { shards: ids } = shards(FIRST);
  const done = postShard(board, 'r-a', 5);
  const held = claimJob(board.db, { runner: 'r-b', capabilities: [], now: 7 });
  assert.ok(held, 'a runner holds a second shard when the landing ends');
  end(10);
  const views = jobViews(board.db, ids);
  assert.ok(views.every(view => view.step === 'done'), 'every shard is done');
  const withdrawn = ids.filter((_, at) => views[at].steps.some(step => step.name === 'withdrawn'));
  assert.deepEqual(withdrawn.sort(), ids.filter(id => id !== done).sort(), 'the unfinished ones are withdrawn, the posted one keeps its receipt');
  assert.equal(claimJob(board.db, { runner: 'r-c', capabilities: [], now: 11 }), null, 'no runner finds a shard to claim');
});

test('clause 2: a job that is not a land job withdraws nothing when it ends, and a land job with no shards ends cleanly [test] [C7,#7818]', t => {
  const { board, end } = landing(t);
  offerJob(board.db, { id: 'gate:9:x', kind: 'gate', now: 2 });
  offerJob(board.db, { id: 'gate:9:x:shard:1', kind: 'gate-shard', now: 2 });
  assert.doesNotThrow(() => end(10), 'a landing that never sharded ends with nothing to withdraw');
  assert.notEqual(jobViews(board.db, ['gate:9:x:shard:1'])[0].step, 'done', 'another job\'s shard is untouched');
});

test('clause 2: shards offered again for another merged commit end the old ones and never hand back the old tree\'s receipts [test] [C7,#7818]', t => {
  const { board, shards, receipts } = landing(t);
  const first = shards(FIRST).shards;
  postShard(board, 'r-a', 5);
  assert.ok(receipts(first).shards.some(row => row.posted), 'the first tree has a posted receipt');
  const again = shards(SECOND, {}, 8).shards;
  assert.equal(again.length, first.length);
  assert.ok(again.every(id => !first.includes(id)), 'a shard id the first tree used is not reused for the second');
  assert.ok(receipts(again, 9).shards.every(row => row.posted === null), 'the second tree starts with no receipt');
  const old = jobViews(board.db, first).filter(view => view.step !== 'done');
  assert.deepEqual(old, [], 'every shard of the first tree is done, posted or withdrawn');
  assert.deepEqual(shards(SECOND, {}, 9).shards, again, 'asking again for the same merged commit returns the same shards');
});

test('clause 2: the shards carry the landing ref their runner fetches, and a ref outside refs/pullboard/landing is refused [test] [C7,#7818]', t => {
  const { board, shards } = landing(t);
  const claim = claimJob(board.db, { runner: 'r-a', capabilities: [], now: 4 });
  assert.equal(claim, null, 'nothing is claimable before shards are offered');
  const { shards: ids } = shards(FIRST);
  const shard = claimJob(board.db, { runner: 'r-a', capabilities: [], now: 5 });
  assert.equal(jobRequest(board.db, { job: shard.job, runner: 'r-a', token: shard.token }).request.ref, REF);
  assert.ok(ids.includes(shard.job));
  assert.throws(() => shards(FIRST, { ref: 'refs/heads/main' }), error => error.code === 'LAND_SHARDS');
});
