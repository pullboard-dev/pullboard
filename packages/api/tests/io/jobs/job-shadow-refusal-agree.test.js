/** The job shadow compare reads a hop fence as the same refusal the job table follows, and still records a genuine difference [C7,#9784]. */
/** @pullboard-test-input packages/api/src/io/jobs.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { readShadow } from '../../../../store/index.js';
import { claimJob } from '../../../index.js';
import { gateClaimHop } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { postReceipt } from '../../../index.js';
import { provideGateHopTable } from '../../../index.js';
import { provideJobTable } from '../../../index.js';
import { renewJob } from '../../../index.js';

const T0 = Date.parse('2026-11-16T17:42:00.000Z');
const LEASE_MS = 120_000;
const CANDIDATE = 'c0ffee'.padEnd(40, '0');

provideGateHopTable(leaseMs => ({ hop, now }, { name, actor, epoch }) => {
  if (name === 'create') return { patch: { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: CANDIDATE, digest: CANDIDATE } } };
  if (name === 'acquire') return { patch: { hop: { ...hop, state: 'driven', owner: actor, epoch: hop.epoch + 1, leaseUntil: now + leaseMs } } };
  if (hop.state !== 'driven' || hop.owner !== actor || hop.epoch !== epoch) return { refused: { code: 'HOP_FENCED', message: `${actor} at epoch ${epoch} does not own this hop` } };
  return name === 'finish' ? { patch: { hop: { ...hop, state: 'done', owner: null } } } : { patch: { hop: { ...hop, leaseUntil: now + leaseMs } } };
});

/** A job table that answers the holder's moves as the real table does, with no knowledge of the gate hop. */
function holderTable(snapshot, move) {
  if (move.runner !== snapshot.job?.claim?.runner || move.token !== snapshot.job?.claim?.token) return { refused: { code: 'JOB_LEASE_MOVED' } };
  if (move.name === 'receipt') return { patch: { job: { ...snapshot.job, step: 'done', owner: null, leaseUntil: 0 } } };
  return { patch: { job: { ...snapshot.job, leaseUntil: snapshot.now + LEASE_MS } } };
}

/** A shadowed board with one gate job claimed by r-holder at hop epoch 1, named like a recorded disagreement; `seen` collects every compare. */
function claimed(t, id, table = holderTable) {
  const db = cellBoard(t, ':memory:').db;
  const compares = [];
  provideJobTable(table);
  t.after(() => provideJobTable(null));
  offerJob(db, { id, kind: 'gate', needs: [], item: 7, candidate: CANDIDATE, now: T0 });
  const hop = gateClaimHop(true);
  const claim = claimJob(db, { runner: 'r-holder', now: T0, leaseMs: LEASE_MS, hop });
  db.jobQueueShadow = { decide: table, seen: compare => compares.push(compare) };
  return { db, hop, id, token: claim.token, compares };
}

/** Other runner takes the item's hop at a later epoch. */
function hopTaken(db) { db.prepare("UPDATE gate_hop SET owner = 'r-other', epoch = 2 WHERE item = 7").run(); }
/** A resubmit finished the item's hop at another candidate. */
function hopMovedOn(db) { db.prepare("UPDATE gate_hop SET state = 'done', owner = NULL, hop_commit = ? WHERE item = 7").run('d'.repeat(40)); }

const tries = move => { try { move(); return null; } catch (error) { return error.code; } };
const renew = ({ db, hop, id, token }) => tries(() => renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000, leaseMs: LEASE_MS, hop }));
const receipt = ({ db, hop, id, token }) => tries(() => postReceipt(db, { job: id, runner: 'r-holder', token, receipt: { status: 0 }, now: T0 + 1_000, leaseMs: LEASE_MS, hop }));

test('api.jobs-job-shadow-refusal-agree.compare-carries-writer-refusal: clause 1: gate:9408, gate:9275 and gate:9509 rebuilt, each compare carries the writer refusal code HOP_FENCED, and a differing refusal records its code in the entry [C7,#9784]', t => {
  for (const [id, fence, move] of [['gate:9408:a', hopTaken, renew], ['gate:9275:b', hopTaken, receipt], ['gate:9509:c', hopMovedOn, renew]]) {
    const held = claimed(t, id);
    fence(held.db);
    assert.equal(move(held), 'HOP_FENCED', id);
    assert.equal(held.compares.length, 1, id);
    assert.equal(held.compares[0].wrote.refused, 'HOP_FENCED', id);
  }
  const stale = claimed(t, 'gate:9408:d', () => ({ patch: { job: { step: 'claimed' } } }));
  stale.db.movesShadow = true;
  provideJobTable(() => ({ patch: { job: { step: 'claimed' } } }));
  delete stale.db.jobQueueShadow;
  const wrongToken = tries(() => renewJob(stale.db, { job: stale.id, runner: 'r-holder', token: 'wrong-token', now: T0 + 1_000, leaseMs: LEASE_MS, hop: stale.hop }));
  assert.ok(wrongToken, 'the writer refuses a renew with the wrong token');
  const counts = readShadow({ db: stale.db }, 'job');
  assert.equal(counts.disagreed, 1);
  assert.equal(counts.last[0].refusal, wrongToken);
});

test('api.jobs-job-shadow-refusal-agree.renew-fenced-by-other-runner: clause 2: gate:9408 rebuilt, a renew after another runner took the hop is refused HOP_FENCED and the job table refuses the same move [C7,#9784]', t => {
  const held = claimed(t, 'gate:9408:a');
  held.db.movesShadow = true;
  delete held.db.jobQueueShadow;
  hopTaken(held.db);
  assert.equal(renew(held), 'HOP_FENCED');
  const counts = readShadow({ db: held.db }, 'job');
  assert.equal(counts.compared, 1);
  assert.equal(counts.disagreed, 0, `the recorded differs path is null: ${JSON.stringify(counts.last)}`);
});

test('api.jobs-job-shadow-refusal-agree.receipt-fenced-by-other-runner: clause 2: gate:9275 rebuilt, a receipt after another runner took the hop is refused HOP_FENCED and the job table refuses the same move [C7,#9784]', t => {
  const held = claimed(t, 'gate:9275:b');
  held.db.movesShadow = true;
  delete held.db.jobQueueShadow;
  hopTaken(held.db);
  assert.equal(receipt(held), 'HOP_FENCED');
  const counts = readShadow({ db: held.db }, 'job');
  assert.equal(counts.compared, 1);
  assert.equal(counts.disagreed, 0, `the recorded differs path is null: ${JSON.stringify(counts.last)}`);
});

test('api.jobs-job-shadow-refusal-agree.renew-after-hop-moved-on: clause 2: gate:9509 rebuilt, a renew after a resubmit moved the hop on is refused HOP_FENCED and the job table refuses the same move [C7,#9784]', t => {
  const held = claimed(t, 'gate:9509:c');
  held.db.movesShadow = true;
  delete held.db.jobQueueShadow;
  hopMovedOn(held.db);
  assert.equal(renew(held), 'HOP_FENCED');
  const counts = readShadow({ db: held.db }, 'job');
  assert.equal(counts.compared, 1);
  assert.equal(counts.disagreed, 0, `the recorded differs path is null: ${JSON.stringify(counts.last)}`);
});

test('api.jobs-job-shadow-refusal-agree.genuine-difference-still-recorded: clause 3: a job move whose table row genuinely differs from the writer still records a differing path [C7,#9784]', t => {
  const held = claimed(t, 'gate:9408:e', (snapshot, move) => (move.name === 'receipt' ? { patch: { job: { ...snapshot.job, step: 'claimed' } } } : holderTable(snapshot, move)));
  held.db.movesShadow = true;
  delete held.db.jobQueueShadow;
  assert.equal(receipt(held), null);
  const counts = readShadow({ db: held.db }, 'job');
  assert.equal(counts.disagreed, 1, 'the receipt step differs from the writer');
  assert.equal(counts.last[0].differs, 'job.step');
});
