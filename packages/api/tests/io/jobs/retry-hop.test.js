/** @pullboard-test-input source-cell api */
/** With gate.fencedHop on, a gate job offered again at a candidate whose gate finished reopens the hop at that candidate and runs, rather than being refused HOP_OVER [C7,#8464]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { temporaryDirectory } from '../../../../store/tests/fixtures/tmp.js';
import { readGateHop } from '../../../../store/index.js';
import { claimJob } from '../../../index.js';
import { endGateHop } from '../../../index.js';
import { gateClaimHop } from '../../../index.js';
import { provideGateHopTable } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { postReceipt } from '../../../index.js';

const LEASE = 60_000;
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

/** A real board file with item 7's first gate job at OLD. */
function board(t) {
  const root = temporaryDirectory('pullboard-retry-hop-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(db, { id: 'gate:7:first', kind: 'gate', needs: [], item: 7, candidate: OLD, now: 1000 });
  return db;
}

/** The hop table's rows these moves need, as pullboard serve provides the moves cell's table (a cell test may not import it). */
provideGateHopTable(leaseMs => ({ item, hop, now }, { name, actor, epoch }) => {
  const over = hop && (hop.state === 'ended' || hop.state === 'done');
  if (name === 'create') return hop ? { refused: { code: 'HOP_EXISTS', message: 'a hop already exists' } } : { patch: { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: item.commit, digest: item.digest } } };
  if (over) return { refused: { code: 'HOP_OVER', message: 'the hop is already done or ended' } };
  if (name === 'acquire') return { patch: { hop: { ...hop, state: 'driven', owner: actor, epoch: hop.epoch + 1, leaseUntil: now + leaseMs } } };
  if (name === 'end') return { patch: { hop: { ...hop, state: 'ended', owner: null, epoch: hop.epoch + 1 } } };
  if (name === 'finish') return hop.owner === actor && hop.epoch === epoch ? { patch: { hop: { ...hop, state: 'done', owner: null } } } : { refused: { code: 'HOP_FENCED', message: `${actor} does not own this hop` } };
  return hop.owner === actor && hop.epoch === epoch ? { patch: { hop: { ...hop, leaseUntil: now + leaseMs } } } : { refused: { code: 'HOP_FENCED', message: `${actor} does not own this hop` } };
});

const claim = (db, runner, now) => claimJob(db, { runner, now, leaseMs: LEASE, hop: gateClaimHop(true) });
const post = (db, held, runner, now) => postReceipt(db, { job: held.job, runner, token: held.token, receipt: { ok: true }, now, leaseMs: LEASE, hop: gateClaimHop(true) });

test('clause 1: a gate offered again at a candidate whose gate finished is claimed and reopens its hop at a later epoch [C7,#8464]', t => {
  const db = board(t);
  const first = claim(db, 'r1', 5000);
  post(db, first, 'r1', 6000);
  assert.deepEqual([readGateHop(db, 7).state, readGateHop(db, 7).commit, readGateHop(db, 7).epoch], ['done', OLD, 1]);
  offerJob(db, { id: 'gate:7:again', kind: 'gate', needs: [], item: 7, candidate: OLD, now: 7000 });
  const again = claim(db, 'r2', 8000);
  assert.equal(again.job, 'gate:7:again', 'the retried gate is claimed, not refused HOP_OVER');
  assert.deepEqual([readGateHop(db, 7).state, readGateHop(db, 7).owner, readGateHop(db, 7).commit, readGateHop(db, 7).epoch], ['driven', 'r2', OLD, 2]);
  post(db, again, 'r2', 9000);
  assert.equal(readGateHop(db, 7).state, 'done', 'the retried gate finishes its reopened hop');
});

test('clause 1: a hop a resubmit ended at this candidate stays over, so its old gate job still ends as superseded [C7,#8353]', t => {
  const db = board(t);
  claim(db, 'r1', 5000);
  endGateHop(db, gateClaimHop(true), { item: 7, candidate: NEW, now: 6000, leaseMs: LEASE });
  offerJob(db, { id: 'gate:7:new', kind: 'gate', needs: [], item: 7, candidate: NEW, now: 6000 });
  assert.equal(claim(db, 'r2', 5000 + LEASE + 1).job, 'gate:7:new');
  assert.equal(db.prepare("SELECT job_step FROM job WHERE job_id = 'gate:7:first'").get().job_step, 'done');
});
