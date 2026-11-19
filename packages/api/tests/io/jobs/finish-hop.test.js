/** @pullboard-test-input source-cell api */
/** With gate.fencedHop on, posting a gate job's receipt finishes its item's hop row: it reads done, with no owner, at the epoch the claim held [C7,#8464]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { temporaryDirectory } from '../../../../board/tests/fixtures/board.js';
import { readGateHop } from '../../../../store/index.js';
import { claimJob } from '../../../index.js';
import { gateClaimHop } from '../../../index.js';
import { provideGateHopTable } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { postReceipt } from '../../../index.js';

const ITEM = 7;
const LEASE = 60_000;
const CANDIDATE = 'c0ffee'.padEnd(40, '0');

/** A real board file with one gate job offered for ITEM at CANDIDATE. */
function board(t) {
  const root = temporaryDirectory('pullboard-finish-hop-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(db, { id: 'gate:7:a', kind: 'gate', needs: [], item: ITEM, candidate: CANDIDATE, now: 1000 });
  return db;
}

/** The hop table's rows the claim and the receipt need, as pullboard serve provides them (a cell test may not import the moves cell). */
provideGateHopTable(leaseMs => ({ hop, now }, { name, actor, epoch }) => {
  if (name === 'create') return { patch: { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: CANDIDATE, digest: CANDIDATE } } };
  if (name === 'acquire') return { patch: { hop: { ...hop, state: 'driven', owner: actor, epoch: hop.epoch + 1, leaseUntil: now + leaseMs } } };
  if (hop.state !== 'driven' || hop.owner !== actor || hop.epoch !== epoch) return { refused: { code: 'HOP_FENCED', message: `${actor} at epoch ${epoch} does not own this hop` } };
  return name === 'finish' ? { patch: { hop: { ...hop, state: 'done', owner: null } } } : { patch: { hop: { ...hop, leaseUntil: now + leaseMs } } };
});

test('api.jobs-finish-hop.gate-job-whose-receipt-posted: clause 1: a gate job whose receipt is posted leaves its hop row done, and a retried post leaves it done [C7,#8464]', t => {
  const db = board(t);
  const taken = claimJob(db, { runner: 'r1', now: 5000, leaseMs: LEASE, hop: gateClaimHop(true) });
  assert.equal(readGateHop(db, ITEM).state, 'driven', 'a claimed gate drives its hop');
  const post = () => postReceipt(db, { job: taken.job, runner: 'r1', token: taken.token, receipt: { ok: true }, now: 6000, leaseMs: LEASE, hop: gateClaimHop(true) });
  assert.equal(post().recorded, true);
  const done = readGateHop(db, ITEM);
  assert.deepEqual([done.state, done.owner, done.epoch], ['done', null, 1], 'the hop is done at the epoch the claim held');
  assert.equal(post().recorded, false, 'the retried post returns the stored receipt');
  assert.equal(readGateHop(db, ITEM).state, 'done');
});

test('api.jobs-finish-hop.gate-fencedhop-off-posted-receipt: clause 1: with gate.fencedHop off, a posted receipt writes no hop row [C7,#8464]', t => {
  const db = board(t);
  const taken = claimJob(db, { runner: 'r1', now: 5000, leaseMs: LEASE, hop: gateClaimHop(false) });
  postReceipt(db, { job: taken.job, runner: 'r1', token: taken.token, receipt: { ok: true }, now: 6000, leaseMs: LEASE, hop: gateClaimHop(false) });
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gate_hop'").get(), undefined);
});
