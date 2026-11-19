/** A runner job's token is scoped to its own claim, and only a landing job's claim carries the permit that moves trunk [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { trunkPushVerdict } from '../../../git/index.js';
import { jobQueueCall } from '../../index.js';
import { offerJob } from '../../index.js';
import { offerLandingJob } from '../../index.js';
import { withLandingPermit } from '../../index.js';

const KEY = 'fixture-landing-key-0123456789';
const TRUNK = 'refs/heads/main';
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const T0 = 1_000_000;
// Budget: a lease is a minute here so lapsing it is one number, never a wait.
const LEASE_MS = 60_000;

/** One queue call as the board answers it, with a landing permit added for a land job as the API does. */
function call(db, body, now) {
  return withLandingPermit(db, body, jobQueueCall(db, body, { mode: 'pull', now }), () => KEY);
}

/** The code a call refused with, or null when it answered. */
function refusal(run) {
  try { run(); return null; } catch (error) { return error.code ?? String(error); }
}

test('api.job-token-scope.claim-token-renews-posts-receipt: clause 1: a claim\'s token renews and posts a receipt for that job only, and a later claim ends it [P7]', t => {
  const db = cellBoard(t, ':memory:').db;
  offerJob(db, { id: 'gate:one', kind: 'gate', now: T0 });
  offerJob(db, { id: 'gate:two', kind: 'gate', now: T0 });
  const first = call(db, { action: 'claim', runner: 'r-a', kinds: ['gate'] }, T0).claim;
  const second = call(db, { action: 'claim', runner: 'r-a', kinds: ['gate'] }, T0).claim;
  assert.notEqual(first.job, second.job);
  assert.notEqual(first.token, second.token, 'each claim returns its own token');
  assert.equal(call(db, { action: 'renew', job: first.job, runner: 'r-a', token: first.token }, T0 + 1000).renewed, true, 'the token renews its own job');
  for (const [why, body] of [
    ['renew another job', { action: 'renew', job: second.job, runner: 'r-a', token: first.token }],
    ['receipt another job', { action: 'receipt', job: second.job, runner: 'r-a', token: first.token, receipt: { status: 0 } }],
    ['renew as another runner', { action: 'renew', job: first.job, runner: 'r-b', token: first.token }],
  ]) assert.equal(refusal(() => call(db, body, T0 + 1000)), 'JOB_LEASE_MOVED', `its token cannot ${why}`);
  // Once the lease lapsed and another runner claimed the job, the old token holds nothing.
  const later = T0 + 10 * LEASE_MS;
  const taken = call(db, { action: 'claim', runner: 'r-b', kinds: ['gate'] }, later).claim;
  const lost = taken.job;
  const old = lost === first.job ? first : second;
  for (const action of ['renew', 'receipt']) {
    assert.equal(refusal(() => call(db, { action, job: lost, runner: 'r-a', token: old.token, receipt: { status: 0 } }, later + 1)), 'JOB_LEASE_MOVED', `the lapsed claim's token cannot ${action}`);
  }
  assert.equal(call(db, { action: 'receipt', job: lost, runner: 'r-b', token: taken.token, receipt: { status: 0 } }, later + 2).recorded, true, 'the new holder posts');
});

test('api.job-token-scope.only-landing-job-claim-carries: clause 2: only a landing job\'s claim carries a permit the trunk guard accepts [P7,B3]', async t => {
  const db = cellBoard(t, ':memory:').db;
  offerJob(db, { id: 'gate:plain', kind: 'gate', now: T0 });
  offerLandingJob(db, { items: [{ id: 5723, commit: 'c'.repeat(40), ref: 'refs/pullboard/land/5723' }], expect: OLD, config: { trunk: { remote: '/trunk.git' } }, now: T0 });
  const landing = call(db, { action: 'claim', runner: 'r-land', kinds: ['land'] }, T0).claim;
  const gate = call(db, { action: 'claim', runner: 'r-gate', kinds: ['gate'] }, T0).claim;
  assert.equal(gate.permit, undefined, 'a non-landing claim carries no permit');
  const push = (permit, now = T0 + 1000) => trunkPushVerdict({ updates: [{ old: OLD, new: NEW, ref: TRUNK }], now, key: KEY, trunk: TRUNK, isAncestor: () => true,
    options: permit ? [`pullboard-job=${permit.job}`, `pullboard-runner=${permit.runner}`, `pullboard-lease-until=${permit.leaseUntil}`, `pullboard-permit=${permit.mac}`] : [] });
  const bare = await push(null);
  assert.deepEqual([bare.ok, bare.code], [false, 'TRUNK_RECEIPT'], 'the gate job\'s push has no permit and is refused');
  const forged = await push({ ...landing.permit, job: gate.job });
  assert.deepEqual([forged.ok, forged.code], [false, 'TRUNK_RECEIPT'], 'a permit moved onto another job is refused');
  assert.equal((await push(landing.permit)).ok, true, 'the landing job\'s push goes through');
  const lapsed = await push(landing.permit, landing.permit.leaseUntil + 1);
  assert.deepEqual([lapsed.ok, lapsed.code], [false, 'TRUNK_LEASE'], 'and its permit ends with its lease');
});
