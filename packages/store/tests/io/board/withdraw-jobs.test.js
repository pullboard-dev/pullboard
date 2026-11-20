/** A board withdrawal and a hand-landing record end the item's open gate and gate-shard jobs when told to, and leave them open when not [C7,#11819]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { createJob } from '../../../../jobs/index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';

// fixture-subject: addItem (a store unit test of withdraw and merged over a hand-built claimed item)
const SYNTHETIC_MODEL = 'Synthetic fixture model';
const COMMIT = 'c'.repeat(40);
const freeze = () => ({ text: '{}', digest: 'synthetic-withdraw-jobs-bar' });

/** A claimed item with its gate job and two shards open, and another item's gate job that must never end. */
function fixture(t) {
  const board = fixtureBoard(t);
  for (const id of ['coordinator', 'core-1']) store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, model: SYNTHETIC_MODEL });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Withdraw jobs fixture' });
  const other = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Other item fixture' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze });
  createJob(board.db, { id: `gate:${id}`, kind: 'gate', item: id, candidate: COMMIT, now: 1000 });
  for (const n of [1, 2]) createJob(board.db, { id: `gate:${id}:shard:${n}`, kind: 'gate-shard', item: id, candidate: COMMIT, now: 1000 });
  createJob(board.db, { id: `gate:${other}`, kind: 'gate', item: other, candidate: COMMIT, now: 1000 });
  const steps = () => board.db.prepare('SELECT job_id AS id, job_step AS step FROM job ORDER BY job_id').all().map(row => `${row.id}=${row.step}`);
  return { board, id, other, steps };
}

/** The three jobs of the item as `done` or `open`, and whether the other item's job stayed open. */
function outcome(f) {
  const state = Object.fromEntries(f.steps().map(row => row.split('=')));
  const mine = [`gate:${f.id}`, `gate:${f.id}:shard:1`, `gate:${f.id}:shard:2`].map(job => (state[job] === 'done' ? 'done' : 'open'));
  return { mine, otherOpen: state[`gate:${f.other}`] !== 'done' };
}

test('store.io-board-withdraw-jobs.board-withdraw-ends-open-jobs: clause 1: the board withdraw ends the item\'s gate job and both shards when endGateJobs is on, and leaves all three open when it is off [C7,#11819]', t => {
  const on = fixture(t);
  store.withdraw(on.board, on.id, { agentId: 'coordinator', reason: 'duplicate of another item', endGateJobs: true });
  assert.deepEqual(outcome(on), { mine: ['done', 'done', 'done'], otherOpen: true });
  const off = fixture(t);
  store.withdraw(off.board, off.id, { agentId: 'coordinator', reason: 'duplicate of another item' });
  assert.deepEqual(outcome(off), { mine: ['open', 'open', 'open'], otherOpen: true });
});

test('store.io-board-withdraw-jobs.hand-landing-ends-open-jobs: clause 2: the hand-landing record ends the item\'s gate job and both shards when endGateJobs is on, and leaves all three open when it is off [C7,#11819]', t => {
  const land = f => store.merged(f.board, f.id, { agentId: 'coordinator', commit: COMMIT, forced: 'landed by hand', waiveProof: 'synthetic fixture, no run', endGateJobs: f.endGateJobs });
  const on = fixture(t);
  land({ ...on, endGateJobs: true });
  assert.equal(store.getItem(on.board, on.id).item_merged_commit, COMMIT);
  assert.deepEqual(outcome(on), { mine: ['done', 'done', 'done'], otherOpen: true });
  const off = fixture(t);
  land({ ...off, endGateJobs: undefined });
  assert.equal(store.getItem(off.board, off.id).item_merged_commit, COMMIT);
  assert.deepEqual(outcome(off), { mine: ['open', 'open', 'open'], otherOpen: true });
});
