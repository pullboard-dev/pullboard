/** A sharded gate's result applies once, however many board processes reach it at once, so review reuses its submit proof [C7,P7,#10862,#10954]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { headTree } from '../../../../git/index.js';
import * as store from '../../../../store/index.js';
import { reusableSubmitProof } from '../../../../verify/index.js';
import { applyShardReceipt } from '../../../index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { postReceipt } from '../../../index.js';

const FILES = ['web/a.test.js', 'web/b.test.js', 'web/c.test.js', 'web/d.test.js'];
const PROOF = `node --test ${FILES.map(file => `'./${file}'`).join(' ')}`;
const ENVIRONMENT = { node: process.version, platform: process.platform, arch: process.arch };
// Budget: the six appliers start together after this delay, long enough for every thread to open the board first.
const START_DELAY_MS = 1500;

/**
 * A claimed item whose gate job passed its check and left its proof to four shards, all posted green; the last one is
 * recorded alone (postReceipt), so its apply has not run yet and every applier finds the gate done and unsettled.
 */
function doneShardedGate(t) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit, tree = headTree(repo.root);
  const job = `gate:${item.item_id}:once`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  assert.equal(lease?.job, job, 'the runner pulls the offered gate');
  const gate = { version: 1, source: head, green: false, environment: ENVIRONMENT, phases: [{ role: 'check', status: 0 }], analysis: { proofFiles: FILES, proofCommand: PROOF },
    proofPlan: { runner: 'node --test', cores: 1, files: FILES } };
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-gate', token: lease.token, receipt: { status: 0, gate } }, { mode: 'pull', now: 3 });
  assert.equal(posted.applied.outcome, 'sharded', JSON.stringify(posted.applied));
  const shards = posted.applied.shards;
  assert.equal(shards.length, 4, 'one shard per file');
  shards.forEach((shard, index) => {
    const at = 10 * (index + 1);
    const claimed = claimJob(board.db, { runner: `r-${at}`, capabilities: [], now: at });
    assert.equal(claimed?.job, shard, 'the runner pulls the next shard');
    const body = { job: shard, runner: `r-${at}`, token: claimed.token, receipt: { version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } } };
    if (index < shards.length - 1) assert.equal(boardJobQueueCall(board, { action: 'receipt', ...body }, { mode: 'pull', now: at + 1 }).applied.outcome, 'waiting');
    else assert.equal(postReceipt(board.db, { ...body, now: at + 1 }).recorded, true, 'the last shard is recorded and its apply not yet run');
  });
  assert.equal(store.getItem(board, item.item_id).item_status, 'claimed', 'the gate is done and unsettled');
  return { repo, board, item, seat, head, tree, last: shards.at(-1) };
}

/** The item's submit events, and the claim or renew events that carry a submit admission. */
function counts(board, id) {
  const submits = board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = ? AND event_kind = 'submit'").get(id).n;
  const admissions = board.db.prepare("SELECT event_detail AS detail FROM event WHERE item_id = ? AND event_kind IN ('claim', 'renew') ORDER BY event_id").all(id)
    .map(row => JSON.parse(row.detail).submitAdmission).filter(Boolean);
  return { submits, admissions };
}

/** What review reads: the submit proof reusable at the submitted commit, tree and main, with the plan the gate ran. */
function reuse(board, id, head, tree) {
  return reusableSubmitProof(store.events(board, { itemId: id }), { item: store.getItem(board, id), commit: head, tree, main: head, check: '', affectedTests: 'node --test', gate: '',
    expectedPlan: { check: '', files: FILES, full: false, deferred: false, proofCommand: PROOF, tiered: false } });
}

/**
 * One applier on its own board connection in its own thread, as each board process holds its own: the shard post's
 * apply, or a pull claim whose reconcile settles done gates. Each thread blocks only itself, so the appliers truly overlap.
 */
const APPLIER = `
const { workerData, parentPort } = require('node:worker_threads');
(async () => {
  const { file, root, job, mode, runner, start, fixture, api: door } = workerData;
  const { openCellBoard, closeCellBoard } = await import(fixture);
  const api = await import(door);
  const board = openCellBoard(file, undefined, { gitRoot: root });
  board.gitRoot = root;
  board.db.exec('PRAGMA busy_timeout = 30000');
  while (Date.now() < start) { /* every applier starts at the same moment */ }
  let outcome;
  try {
    outcome = mode === 'post' ? api.applyShardReceipt(board, { job }).outcome : (api.boardJobQueueCall(board, { action: 'claim', runner, capabilities: [] }, { mode: 'pull' }), 'claimed');
  } catch (error) { outcome = 'error ' + (error && error.code || '') + ' ' + (error && error.message); }
  closeCellBoard(board);
  parentPort.postMessage(outcome);
})();
`;
const FIXTURE_URL = new URL('../../../../store/tests/fixtures/cell.js', import.meta.url).href;
const API_URL = new URL('../../../index.js', import.meta.url).href;

/** Run one applier thread to its end and read the outcome it posted. */
function applier(repo, last, mode, runner, start) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(APPLIER, { eval: true, workerData: { file: repo.boardFile, root: repo.root, job: last, mode, runner, start, fixture: FIXTURE_URL, api: API_URL } });
    let outcome = null;
    worker.on('message', value => { outcome = value; });
    worker.on('error', reject);
    worker.on('exit', code => code === 0 && outcome !== null ? resolve(outcome) : reject(new Error(`applier ${mode} exited ${code}`)));
  });
}

test('api.gate-apply-once.concurrent-applies-submit-once: clause 1: six board connections applying one done sharded gate at once (the shard post and the pull claim reconcile) submit it once under one admission, and review reuses its proof [C7,P7,#10862]', async t => {
  const { repo, board, item, head, tree, last } = doneShardedGate(t);
  const start = Date.now() + START_DELAY_MS;
  const modes = ['post', 'claim', 'post', 'claim', 'post', 'claim'];
  const outcomes = await Promise.all(modes.map((mode, index) => applier(repo, last, mode, `r-apply-${index}`, start)));
  const posts = outcomes.filter((_, index) => modes[index] === 'post');
  assert.ok(outcomes.every(outcome => !String(outcome).startsWith('error')), JSON.stringify(outcomes));
  assert.ok(posts.every(outcome => ['review', 'already-settling'].includes(outcome)), `each post applied or lost the claim: ${JSON.stringify(outcomes)}`);
  assert.equal(store.getItem(board, item.item_id).item_status, 'submitted', 'the gate settled its item');
  const { submits, admissions } = counts(board, item.item_id);
  assert.equal(submits, 1, 'exactly one submit');
  assert.equal(admissions.length, 1, `exactly one submit admission: ${JSON.stringify(admissions)}`);
  const reused = reuse(board, item.item_id, head, tree);
  assert.ok(Array.isArray(reused.ids) && reused.ids.length > 0, `review reuses the submit proof: ${JSON.stringify(reused)}`);
});

test('api.gate-apply-once.admission-reused-same-source: clause 2: a live claim that already carries a submit admission for the gate commit and tree keeps it, so the receipts name it and review reuses them [C7,P7,#10954]', t => {
  const { board, item, seat, head, tree, last } = doneShardedGate(t);
  const held = store.getItem(board, item.item_id);
  const witness = { id: randomUUID(), commit: head, tree };
  store.admitSubmit(board, item.item_id, { agentId: seat.id, lane: held.item_lane, leaseMs: Date.parse(held.item_lease_until) - Date.now(), freeze: () => null, submitAdmission: witness });
  assert.equal(applyShardReceipt(board, { job: last }).outcome, 'review');
  const { submits, admissions } = counts(board, item.item_id);
  assert.equal(submits, 1, 'one submit');
  assert.deepEqual(admissions.map(row => row.id), [witness.id], 'no second admission was minted');
  const reused = reuse(board, item.item_id, head, tree);
  assert.ok(Array.isArray(reused.ids) && reused.ids.length > 0, `review reuses the submit proof: ${JSON.stringify(reused)}`);
  const linked = store.events(board, { itemId: item.item_id }).filter(row => row.event_kind === 'proof-run').map(row => JSON.parse(row.event_detail).receipt);
  assert.ok(linked.length > 0 && linked.every(run => run.submitAdmission === witness.id), 'every proof-run receipt names the kept witness');
});
