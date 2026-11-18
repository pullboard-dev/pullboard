/** pulledGateReds, recordPhaseReceipts and reportRunaway take a runs option: with runs_store on they read the gate's job from the runs file, with it off as on main [P7,#9150]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import * as store from '../../../../store/index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { postReceipt } from '../../../index.js';
import { pulledGateReds } from '../../../index.js';
import { recordPhaseReceipts } from '../../../index.js';
import { reportRunaway } from '../../../index.js';

const RED = { version: 1, status: 1, gate: { green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: 'a.test.js', name: 'clause 1: x' }] }] } };

/** A board with one claimed item, and a second database that stands in for the runs file, held the way boardRunsHolder holds it. */
function setup(t) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  cellSeat(board, { lane: 'coordinator', path: '/fixture/coordinator' });
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  return { board, repo, seat, id: item.item_id, runs: { db: cellBoard(t, ':memory:').db } };
}

/** One gate job for the item offered, claimed and given a red receipt in a database. */
function redGate(db, id, repo, runner) {
  const job = `gate:${id}:red`;
  offerJob(db, { id: job, kind: 'gate', needs: [], item: id, candidate: repo.commit, base: repo.commit, now: 1, request: { run: ['true'], input: { data: {} } } });
  const lease = claimJob(db, { runner, capabilities: [], now: 2 });
  postReceipt(db, { job, runner, token: lease.token, receipt: RED, now: 3 });
  return job;
}

test('api.gate-runs-readers-reds.runs-store-pulledgatereds-reads-done: clause 1: with runs_store on, pulledGateReds reads the done gate from the runs file as it reads the job rows with it off [P7,#9150]', t => {
  const on = setup(t), off = setup(t);
  for (const [one, db] of [[on, on.runs.db], [off, off.board.db]]) {
    const job = redGate(db, one.id, one.repo, 'r-9150');
    store.appendFact(one.board, one.id, { agentId: one.seat.id, kind: 'measurement', text: `Gate job ${job} red at ${one.repo.commit.slice(0, 12)}` });
  }
  const expected = pulledGateReds(off.board, off.id).map(red => red.failures);
  assert.equal(expected.length, 1);
  assert.deepEqual(pulledGateReds(on.board, on.id, { runs: on.runs }).map(red => red.failures), expected);
  assert.deepEqual(pulledGateReds(on.board, on.id), [], 'the board holds no job row of its own');
});

test('api.gate-runs-readers-reds.runs-store-recordphasereceipts-names-runner: clause 1: with runs_store on, recordPhaseReceipts names the runner from the runs file receipt row, and reportRunaway names the land job items from its offered row [P7,#9150]', t => {
  const { board, repo, seat, id, runs } = setup(t);
  const job = redGate(runs.db, id, repo, 'r-from-runs');
  const seen = [];
  const view = Object.assign(Object.create(board), { runtimePorts: { sourceAdvanceReceipts: { boardReceiptStore: () => `${repo.root}/receipts`, receiptBody: run => { seen.push(run.proof.runner); return null; } } } });
  const green = { gate: { phases: [{ role: 'proof', status: 0 }] } };
  const fields = { job, receipt: green, id, candidate: repo.commit, main: repo.commit, submit: { agentId: seat.id, digest: 'd', tree: 't' } };
  recordPhaseReceipts(view, { ...fields, runs });
  assert.deepEqual(seen, ['r-from-runs']);
  recordPhaseReceipts(view, fields);
  assert.deepEqual(seen, ['r-from-runs', null], 'without the option the board is read, and it holds no receipt row');
  const land = `land:${id}`;
  offerJob(runs.db, { id: land, kind: 'land', needs: [], payload: { items: [{ id }] }, now: 1 });
  reportRunaway(board, { job: land, kind: 'land', attempts: 5, detail: 'ran away', runs });
  assert.ok(store.itemThread(board, id).some(fact => String(fact.text).startsWith(`Land job ${land} was released to the lane`)), 'the item is noted from the runs file offer');
});

test('api.gate-runs-readers-reds.runs-store-off-default-three: clause 2: with runs_store off (the default) the three read the board exactly as on main [P7,#9150]', t => {
  const { board, repo, seat, id } = setup(t);
  const job = redGate(board.db, id, repo, 'r-board');
  store.appendFact(board, id, { agentId: seat.id, kind: 'measurement', text: `Gate job ${job} red at ${repo.commit.slice(0, 12)}` });
  assert.deepEqual(pulledGateReds(board, id, { runs: null }), pulledGateReds(board, id));
  assert.equal(pulledGateReds(board, id).length, 1);
  const seen = [];
  const view = Object.assign(Object.create(board), { runtimePorts: { sourceAdvanceReceipts: { boardReceiptStore: () => `${repo.root}/receipts`, receiptBody: run => { seen.push(run.proof.runner); return null; } } } });
  recordPhaseReceipts(view, { job, receipt: { gate: { phases: [{ role: 'proof', status: 0 }] } }, id, candidate: repo.commit, main: repo.commit, submit: { agentId: seat.id, digest: 'd', tree: 't' } });
  assert.deepEqual(seen, ['r-board']);
  const land = `land:${id}`;
  offerJob(board.db, { id: land, kind: 'land', needs: [], payload: { items: [{ id }] }, now: 1 });
  reportRunaway(board, { job: land, kind: 'land', attempts: 5, detail: 'ran away' });
  assert.ok(store.itemThread(board, id).some(fact => String(fact.text).startsWith(`Land job ${land} was released to the lane`)));
});
