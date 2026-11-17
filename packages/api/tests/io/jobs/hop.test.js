/** @pullboard-test-input source-cell api */
/** With gate.fencedHop on, a runner claiming a pulled gate job takes its item's hop through the fenced gate row, and a claim holding a replaced epoch is refused HOP_FENCED [C7,#8352]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { temporaryDirectory } from '../../../../board/tests/fixtures/board.js';
import { jobView } from '../../../../jobs/index.js';
import { readGateHop } from '../../../../store/index.js';
import { claimJob } from '../../../index.js';
import { gateClaimHop } from '../../../index.js';
import { provideGateHopTable } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { renewJob } from '../../../index.js';

const ITEM = 7;
const LEASE = 60_000;
const CANDIDATE = 'c0ffee'.padEnd(40, '0');

/** A real board file with one gate job offered for ITEM at CANDIDATE, plus any more ids given. */
function board(t, ids = ['gate:7:a']) {
  const root = temporaryDirectory('pullboard-claim-hop-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  ids.forEach((id, at) => offerJob(db, { id, kind: 'gate', needs: [], item: ITEM, candidate: CANDIDATE, now: 1000 + at }));
  return db;
}

/**
 * The hop table's rows the claim needs, as pullboard serve provides the moves cell's table (a cell test may not import it): create, acquire a queued
 * or lapsed hop at the next epoch, and step only as the owner at its epoch.
 */
provideGateHopTable(leaseMs => ({ hop, now }, { name, actor, epoch }) => {
  if (name === 'create') return { patch: { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: CANDIDATE, digest: CANDIDATE } } };
  if (name === 'acquire') {
    return hop.state === 'queued' || hop.leaseUntil < now ? { patch: { hop: { ...hop, state: 'driven', owner: actor, epoch: hop.epoch + 1, leaseUntil: now + leaseMs } } }
      : { refused: { code: 'HOP_HELD', message: `the hop is driven by ${hop.owner} and its lease has not lapsed` } };
  }
  return hop.owner === actor && hop.epoch === epoch ? { patch: { hop: { ...hop, leaseUntil: now + leaseMs } } }
    : { refused: { code: 'HOP_FENCED', message: `${actor} at epoch ${epoch} does not own this hop (owner ${hop.owner} at epoch ${hop.epoch})` } };
});

const claim = (db, runner, now, fencedHop = true) => claimJob(db, { runner, now, leaseMs: LEASE, hop: gateClaimHop(fencedHop) });
const claimedEpoch = (db, job) => jobView(db, job).steps.filter(step => step.name === 'claimed').at(-1).payload.hopEpoch;

test('api.jobs-hop.gate-fencedhop-claimjob-gate-job: clause 1: with gate.fencedHop on, claimJob for a gate job takes the next hop epoch through the fenced gate row [C7,#8352]', t => {
  const db = board(t);
  const first = claim(db, 'r1', 5000);
  assert.deepEqual([readGateHop(db, ITEM).owner, readGateHop(db, ITEM).epoch], ['r1', 1], 'the first claim owns the hop at epoch 1');
  assert.equal(claimedEpoch(db, first.job), 1, 'the claim records the epoch it holds');
  // r1's lease lapses and r2 claims the same gate job: the hop moves to r2 at the next epoch.
  const second = claim(db, 'r2', 5000 + LEASE + 1);
  assert.equal(second.job, first.job);
  assert.deepEqual([readGateHop(db, ITEM).owner, readGateHop(db, ITEM).epoch], ['r2', 2]);
  assert.equal(claimedEpoch(db, second.job), 2);
});

test('api.jobs-hop.gate-fencedhop-off-gate-job: clause 1: with gate.fencedHop off, a gate job claim writes no hop row and records no epoch [C7,#8352]', t => {
  const db = board(t);
  const first = claim(db, 'r1', 5000, false);
  assert.equal(claimedEpoch(db, first.job), undefined);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gate_hop'").get(), undefined, 'no gate_hop table was made');
});

test('api.jobs-hop.claim-holding-stale-epoch-refused: clause 2: a claim holding a stale epoch is refused HOP_FENCED on renew, and the new owner renews [C7,#8352]', t => {
  const db = board(t, ['gate:7:a', 'gate:7:b']);
  const stale = claim(db, 'r1', 5000);
  // r1 keeps its job's lease but not its hop; once the hop lapses, r2 claims the item's other gate job and takes the hop at epoch 2.
  renewJob(db, { job: stale.job, runner: 'r1', token: stale.token, now: 5000 + LEASE - 1, leaseMs: LEASE });
  const owner = claim(db, 'r2', 5000 + LEASE + 1);
  assert.equal(owner.job, 'gate:7:b');
  assert.equal(readGateHop(db, ITEM).epoch, 2);
  assert.throws(() => renewJob(db, { job: stale.job, runner: 'r1', token: stale.token, now: 5000 + LEASE + 2, leaseMs: LEASE, hop: gateClaimHop(true) }), error => {
    assert.equal(error.code, 'HOP_FENCED');
    assert.match(error.message, /r1 at epoch 1.*owner r2 at epoch 2/u, 'the refusal names the stale epoch and the owner');
    return true;
  });
  assert.equal(renewJob(db, { job: owner.job, runner: 'r2', token: owner.token, now: 5000 + LEASE + 2, leaseMs: LEASE, hop: gateClaimHop(true) }).renewed, true);
});

test('api.jobs-hop.while-runner-holds-hop-live: clause 2: while one runner holds the hop live, a claim of the item\'s other gate job is refused HOP_FENCED naming it [C7,#8352]', t => {
  const db = board(t, ['gate:7:a', 'gate:7:b']);
  claim(db, 'r1', 5000);
  assert.throws(() => claim(db, 'r2', 5001), error => {
    assert.equal(error.code, 'HOP_FENCED');
    assert.match(error.message, /driven by r1/u);
    return true;
  });
  assert.equal(jobView(db, 'gate:7:b').leaseOwner ?? null, null, 'the refused claim took no lease');
});
