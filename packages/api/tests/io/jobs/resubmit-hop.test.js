/** @pullboard-test-input source-cell api */
/** With gate.fencedHop on, a resubmit at a new candidate ends the item's open hop, and the old candidate's gate job is then refused HOP_FENCED when it posts its receipt [C7,#8353]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { temporaryDirectory } from '../../../../board/tests/fixtures/board.js';
import { readGateHop } from '../../../../store/index.js';
import { claimJob } from '../../../index.js';
import { endGateHop } from '../../../index.js';
import { gateClaimHop } from '../../../index.js';
import { provideGateHopTable } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { postReceipt } from '../../../index.js';

const ITEM = 7;
const LEASE = 60_000;
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

/** A real board file with one gate job offered for ITEM at the old candidate. */
function board(t) {
  const root = temporaryDirectory('pullboard-resubmit-hop-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(db, { id: 'gate:7:old', kind: 'gate', needs: [], item: ITEM, candidate: OLD, now: 1000 });
  return db;
}

/** The submit's resubmit: end the open hop at the new candidate, then offer its gate job, as offerGateJob does. */
function resubmit(db, now) {
  const ended = endGateHop(db, gateClaimHop(true), { item: ITEM, candidate: NEW, now, leaseMs: LEASE });
  offerJob(db, { id: 'gate:7:new', kind: 'gate', needs: [], item: ITEM, candidate: NEW, now });
  return ended;
}

/**
 * The hop table's rows these moves need, as pullboard serve provides the moves cell's table (a cell test may not import it): create, acquire a queued hop,
 * step only as the live owner at its epoch, and end a hop the item moved off, bumping the epoch.
 */
provideGateHopTable(leaseMs => ({ item, hop, now }, { name, actor, epoch }) => {
  const over = hop && (hop.state === 'ended' || hop.state === 'done');
  if (name === 'create') return hop ? { refused: { code: 'HOP_EXISTS', message: 'a hop already exists' } } : { patch: { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: item.commit, digest: item.digest } } };
  if (over) return { refused: { code: 'HOP_OVER', message: 'the hop is already done or ended' } };
  if (name === 'acquire') return { patch: { hop: { ...hop, state: 'driven', owner: actor, epoch: hop.epoch + 1, leaseUntil: now + leaseMs } } };
  if (name === 'end') return item.commit === hop.commit ? { refused: { code: 'HOP_STILL_WAITS', message: 'the item still waits on this hop' } } : { patch: { hop: { ...hop, state: 'ended', owner: null, epoch: hop.epoch + 1 } } };
  return hop.owner === actor && hop.epoch === epoch ? { patch: { hop: { ...hop, leaseUntil: now + leaseMs } } }
    : { refused: { code: 'HOP_FENCED', message: `${actor} at epoch ${epoch} does not own this hop (owner ${hop.owner} at epoch ${hop.epoch})` } };
});

const claim = (db, runner, now) => claimJob(db, { runner, now, leaseMs: LEASE, hop: gateClaimHop(true) });
const land = (db, held, now) => postReceipt(db, { job: held.job, runner: 'r1', token: held.token, receipt: { ok: true }, now, leaseMs: LEASE, hop: gateClaimHop(true) });

test('api.jobs-resubmit-hop.gate-fencedhop-resubmitting-item-ends: clause 1: with gate.fencedHop on, resubmitting an item ends its open hop in the fenced gate row [C7,#8353]', t => {
  const db = board(t);
  claim(db, 'r1', 5000);
  assert.deepEqual([readGateHop(db, ITEM).state, readGateHop(db, ITEM).epoch], ['driven', 1]);
  assert.deepEqual(resubmit(db, 6000), { ended: true, epoch: 2 }, 'the resubmit ends the hop and bumps its epoch');
  assert.deepEqual([readGateHop(db, ITEM).state, readGateHop(db, ITEM).owner, readGateHop(db, ITEM).commit], ['ended', null, OLD]);
  // The new candidate's gate job claims a fresh hop that keeps counting epochs, so no old claim's epoch comes back.
  const fresh = claim(db, 'r2', 7000);
  assert.equal(fresh.job, 'gate:7:new');
  assert.deepEqual([readGateHop(db, ITEM).state, readGateHop(db, ITEM).owner, readGateHop(db, ITEM).commit, readGateHop(db, ITEM).epoch], ['driven', 'r2', NEW, 3]);
});

test('api.jobs-resubmit-hop.resubmit-same-candidate-gate-fencedhop: clause 1: a resubmit at the same candidate, or with gate.fencedHop off, leaves the hop as it is [C7,#8353]', t => {
  const db = board(t);
  claim(db, 'r1', 5000);
  assert.deepEqual(endGateHop(db, gateClaimHop(true), { item: ITEM, candidate: OLD, now: 6000, leaseMs: LEASE }), { ended: false });
  assert.deepEqual(endGateHop(db, gateClaimHop(false), { item: ITEM, candidate: NEW, now: 6000, leaseMs: LEASE }), { ended: false });
  assert.deepEqual([readGateHop(db, ITEM).state, readGateHop(db, ITEM).epoch], ['driven', 1]);
});

test('api.jobs-resubmit-hop.after-resubmit-old-gate-job: clause 2: after a resubmit the old gate job is refused HOP_FENCED when it tries to land, and records no receipt [C7,#8353]', t => {
  const db = board(t);
  const old = claim(db, 'r1', 5000);
  resubmit(db, 6000);
  assert.throws(() => land(db, old, 6500), error => {
    assert.equal(error.code, 'HOP_FENCED');
    assert.match(error.message, /r1 at epoch 1 no longer owns the hop on #7/u, 'the refusal names the stale claim');
    return true;
  });
  // Still fenced once the new candidate's runner holds the hop, even when the same runner claimed both.
  claim(db, 'r1', 7000);
  assert.throws(() => land(db, old, 7500), { code: 'HOP_FENCED' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = 'gate:7:old' AND job_step_name = 'receipt'").get()?.n ?? 0, 0);
});

test('api.jobs-resubmit-hop.without-resubmit-gate-job-owns: clause 2: without a resubmit the gate job that owns the hop lands [C7,#8353]', t => {
  const db = board(t);
  const held = claim(db, 'r1', 5000);
  assert.equal(land(db, held, 6000).recorded, true);
});
