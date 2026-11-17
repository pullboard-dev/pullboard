/** A land job's runner offers the landing proof as gate-shard jobs through the shards queue action [P7,C7,#7818]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { SHARD_JOB_KIND } from '../../index.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { jobRequest } from '../../index.js';
import { offerJob } from '../../index.js';

const MAIN = 'a'.repeat(40), MERGED = 'b'.repeat(40), CONTEXT = 'c'.repeat(64), KEY = '1'.repeat(64);
const FILES = Array.from({ length: 7 }, (_, at) => `packages/x/tests/f${at + 1}.test.js`);
const GATE = { run: ['node', '-e', 'x'], entry: 'gate.js', commits: [MAIN] };

/** A board holding a green proof-ledger row for the first file, and one claimed land job; returns the call helper. */
function landing(t, { kind = 'land' } = {}) {
  const board = cellBoard(t, ':memory:');
  offerJob(board.db, { id: 'gate:seed', kind: 'gate', now: 1 });
  const seed = claimJob(board.db, { runner: 'r-seed', capabilities: [], now: 2 });
  boardJobQueueCall(board, { action: 'receipt', job: 'gate:seed', runner: 'r-seed', token: seed.token,
    receipt: { version: 1, status: 0, gate: { source: MERGED, green: true, phases: [{ role: 'proof', status: 0, ledger: { contexts: [CONTEXT], files: [[FILES[0], KEY, 0, 'pass']], omitted: 0 } }] } } }, { mode: 'pull', now: 3 });
  offerJob(board.db, { id: 'land:1:k', kind, base: MAIN, needs: [], now: 4 });
  const held = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 5 });
  const call = (extra = {}) => boardJobQueueCall(board, { action: 'shards', job: 'land:1:k', runner: 'r-land', token: held.token, merged: MERGED,
    plan: { runner: 'node --test', files: FILES, cores: 2 }, gate: GATE, ...extra }, { mode: 'pull', now: 6 });
  return { board, call, held };
}

test('api.land-shards.shards-action-offers-proof-gate: #8196 clause 1: the shards action offers the proof as gate-shard jobs land:<job>:shard:N, split round-robin by the gate\'s count rule [C7,#7818]', t => {
  const { board, call } = landing(t);
  const answer = call();
  // Seven files on two cores is ceil(7 / 2) = 4 shards, dealt round-robin.
  assert.deepEqual(answer, { sharded: true, shards: [1, 2, 3, 4].map(n => `land:1:k:shard:${n}`) });
  const files = answer.shards.map(id => jobRequest(board.db, { job: id, runner: 'r-shard', token: claimJob(board.db, { runner: 'r-shard', capabilities: [], now: 7 }).token }));
  assert.ok(files.every(row => row.kind === SHARD_JOB_KIND));
  const parts = files.map(row => row.request.input.data.shard.files).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(parts, [[FILES[0], FILES[4]], [FILES[1], FILES[5]], [FILES[2], FILES[6]], [FILES[3]]]);
});

test('api.land-shards.each-shard-carries-ledger-hits: #8196 clause 2: each shard carries the ledger hits for its own files, with the merged commit as its source [C7,#7818]', t => {
  const { board, call } = landing(t);
  const { shards } = call();
  const requests = shards.map(() => { const held = claimJob(board.db, { runner: 'r-shard', capabilities: [], now: 8 }); return jobRequest(board.db, { job: held.job, runner: 'r-shard', token: held.token }); });
  assert.ok(requests.every(row => row.candidate === MERGED && row.request.input.data.source === MERGED));
  const withHits = requests.filter(row => row.request.input.data.shard.ledger);
  assert.equal(withHits.length, 1, 'only the shard holding the proven file has hits');
  assert.deepEqual(withHits[0].request.input.data.shard.ledger, { contexts: [CONTEXT], files: [[FILES[0], KEY, 0]] });
  assert.ok(withHits[0].request.input.data.shard.files.includes(FILES[0]));
});

test('api.land-shards.plan-within-runner-cores-sharded: #8196 clause 1: a plan within one runner\'s cores is not sharded, and a job that is not a land job or not held is refused [C7,#7818]', t => {
  const { call, board } = landing(t);
  assert.deepEqual(call({ plan: { runner: 'node --test', files: FILES.slice(0, 2), cores: 2 } }), { sharded: false, shards: [] });
  assert.throws(() => call({ token: 'wrong' }), error => error.code === 'JOB_LEASE_MOVED');
  assert.throws(() => call({ merged: 'nope' }), error => error.code === 'LAND_SHARDS');
  const other = landing(t, { kind: 'test' });
  assert.throws(() => other.call(), error => error.code === 'JOB_NOT_LAND');
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM job WHERE job_kind = 'gate-shard'").get().n, 0);
});

test('api.land-shards.x8197-land-job-holder-reads: #8197: the land job\'s holder reads its shards\' receipts back, and nobody else, and only its own shards [C7,#7818]', t => {
  const { board, call, held } = landing(t);
  const { shards } = call();
  const read = (extra = {}) => boardJobQueueCall(board, { action: 'shardReceipts', job: 'land:1:k', runner: 'r-land', token: held.token, shards, ...extra }, { mode: 'pull', now: 7 });
  assert.deepEqual(read().shards.map(row => row.posted), [null, null, null, null], 'no shard has posted yet');
  const shard = claimJob(board.db, { runner: 'r-shard', capabilities: [], now: 8 });
  const receipt = { version: 1, status: 0, gate: { green: true, phases: [{ role: 'proof', status: 0 }] } };
  boardJobQueueCall(board, { action: 'receipt', job: shard.job, runner: 'r-shard', token: shard.token, receipt }, { mode: 'pull', now: 9 });
  const posted = read().shards.find(row => row.job === shard.job).posted;
  assert.equal(posted.runner, 'r-shard');
  assert.deepEqual(posted.receipt, receipt);
  assert.throws(() => read({ token: 'wrong' }), error => error.code === 'JOB_LEASE_MOVED');
  assert.throws(() => read({ shards: ['land:2:z:shard:1'] }), error => error.code === 'LAND_SHARDS');
});
