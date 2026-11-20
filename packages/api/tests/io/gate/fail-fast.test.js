/** With gate.failFastShards on, a shard red in the item's own cases ends the gate's other open shards and applies the red now [C7,P7,#12040]. */
import assert from 'node:assert/strict';
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

const SIGNATURE = 'a'.repeat(64);

/** A claimed item whose gate posted a passed check that leaves its proof to three shards. */
function shardedGate(t, options) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const job = `gate:${item.item_id}:fast`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree: headTree(repo.root), files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  const gate = { version: 1, source: head, green: false, deferred: true, phases: [{ role: 'check', status: 0 }],
    proofPlan: { runner: 'node --test', cores: 2, files: ['web/a.test.js', 'web/b.test.js', 'web/c.test.js'] } };
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-gate', token: lease.token, receipt: { status: 0, gate } }, { mode: 'pull', now: 3, ...options });
  assert.equal(posted.applied.outcome, 'sharded', JSON.stringify(posted.applied));
  assert.ok(posted.applied.shards.length >= 2, 'the proof is split into shards');
  return { board, item, head, shards: posted.applied.shards, options };
}

/** One runner pulls the next shard and posts its red proof naming one failing case in a file. */
function postRed(world, shard, at, gate = {}) {
  const lease = claimJob(world.board.db, { runner: `r-${at}`, capabilities: [], now: at });
  assert.equal(lease?.job, shard, 'the runner pulls the next shard');
  const phase = { role: 'proof', status: 1, failures: [{ name: 'case one', file: 'web/a.test.js' }], failureSignatures: [SIGNATURE] };
  const receipt = { version: 1, status: 1, gate: { source: world.head, green: false, phases: [phase], ...gate } };
  return boardJobQueueCall(world.board, { action: 'receipt', job: shard, runner: `r-${at}`, token: lease.token, receipt }, { mode: 'pull', now: at + 1, ...world.options });
}

/** The shard jobs still open. */
function openShards(board) {
  return board.db.prepare("SELECT job_id FROM job WHERE job_kind = 'gate-shard' AND job_step != 'done'").all().length;
}

const notOnMain = { compareWithMain: ({ cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(file => ({ file, owner: 'item', own: cases.filter(one => one.file === file).map(one => one.name), receipt: null, job: null })) }) };
const onMain = { compareWithMain: ({ cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(file => ({ file, owner: 'main', own: [], receipt: null, job: null })) }) };

test('api.io-gate-fail-fast.item-red-ends-remaining-shards: clause 1: with gate.failFastShards on, a shard that posts red in a file the item changed ends the gate\'s other open shards and applies the red with the unrun shards named [C7,P7,#12040]', t => {
  const world = shardedGate(t, { failFastShards: true, settleOnMainReceipt: true, ...notOnMain });
  const first = postRed(world, world.shards[0], 10);
  assert.notEqual(first.applied.outcome, 'waiting', JSON.stringify(first.applied));
  assert.equal(openShards(world.board), 0, 'the other open shards ended');
  const ended = world.board.db.prepare("SELECT COUNT(*) AS n FROM job_step WHERE job_step_name = 'withdrawn'").get().n;
  assert.equal(ended, world.shards.length - 1, 'every other shard was withdrawn unrun');
  assert.notEqual(store.getItem(world.board, world.item.item_id).item_status, 'submitted');
});

test('api.io-gate-fail-fast.main-red-ends-nothing: clause 1: a shard red only in cases main also fails ends nothing, the gate waits for the rest [C7,P7,#12040]', t => {
  const world = shardedGate(t, { failFastShards: true, settleOnMainReceipt: true, ...onMain });
  const first = postRed(world, world.shards[0], 10);
  assert.equal(first.applied.outcome, 'waiting', JSON.stringify(first.applied));
  assert.equal(openShards(world.board), world.shards.length - 1, 'no other shard ended');
});

test('api.io-gate-fail-fast.setting-off-ends-nothing: clause 1: with the setting off a red shard ends no other shard [C7,P7,#12040]', t => {
  const world = shardedGate(t, { settleOnMainReceipt: true, ...notOnMain });
  const first = postRed(world, world.shards[0], 10);
  assert.equal(first.applied.outcome, 'waiting', JSON.stringify(first.applied));
  assert.equal(openShards(world.board), world.shards.length - 1, 'no other shard ended');
});
