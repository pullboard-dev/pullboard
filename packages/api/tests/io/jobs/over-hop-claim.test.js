/** @pullboard-test-input source-cell api */
/** With gate.fencedHop on, a lapsed gate job whose own candidate's hop is over (a resubmit ended it) ends at the next claim instead of refusing every claim HOP_OVER, so the gate jobs behind it are claimed [C7,#8353]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { temporaryDirectory } from '../../../../board/tests/fixtures/board.js';
import { readGateHop } from '../../../../store/index.js';
import { claimJob } from '../../../index.js';
import { endGateHop } from '../../../index.js';
import { gateClaimHop } from '../../../index.js';
import { provideGateHopTable } from '../../../index.js';
import { offerJob } from '../../../index.js';

const LEASE = 60_000;
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

/** A real board file with item 7's gate job at the old candidate, then item 9's gate job behind it. */
function board(t) {
  const root = temporaryDirectory('pullboard-over-hop-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(db, { id: 'gate:7:old', kind: 'gate', needs: [], item: 7, candidate: OLD, now: 1000 });
  return db;
}

/** The hop table's rows these moves need, as pullboard serve provides the moves cell's table (a cell test may not import it). */
provideGateHopTable(leaseMs => ({ item, hop, now }, { name, actor }) => {
  const over = hop && (hop.state === 'ended' || hop.state === 'done');
  if (name === 'create') return hop ? { refused: { code: 'HOP_EXISTS', message: 'a hop already exists' } } : { patch: { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: item.commit, digest: item.digest } } };
  if (over) return { refused: { code: 'HOP_OVER', message: 'the hop is already done or ended' } };
  if (name === 'acquire') return { patch: { hop: { ...hop, state: 'driven', owner: actor, epoch: hop.epoch + 1, leaseUntil: now + leaseMs } } };
  if (name === 'end') return { patch: { hop: { ...hop, state: 'ended', owner: null, epoch: hop.epoch + 1 } } };
  return { patch: { hop: { ...hop, leaseUntil: now + leaseMs } } };
});

const claim = (db, runner, now) => claimJob(db, { runner, now, leaseMs: LEASE, hop: gateClaimHop(true) });
const step = (db, job) => db.prepare('SELECT job_step FROM job WHERE job_id = ?').get(job).job_step;

test('clause 1: a lapsed gate job whose hop a resubmit ended ends at the next claim, and that claim takes the gate job behind it [C7,#8353]', t => {
  const db = board(t);
  claim(db, 'r1', 5000);
  endGateHop(db, gateClaimHop(true), { item: 7, candidate: NEW, now: 6000, leaseMs: LEASE });
  offerJob(db, { id: 'gate:7:new', kind: 'gate', needs: [], item: 7, candidate: NEW, now: 6000 });
  offerJob(db, { id: 'gate:9:x', kind: 'gate', needs: [], item: 9, candidate: OTHER, now: 6001 });
  const later = 5000 + LEASE + 1;
  const taken = claim(db, 'r2', later);
  assert.equal(taken.job, 'gate:7:new', 'the claim passes the over job and takes the next gate job');
  assert.equal(step(db, 'gate:7:old'), 'done', 'the old job ends, so no claim reaches it again');
  const ended = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = 'gate:7:old' AND job_step_name = 'superseded'").get();
  assert.match(JSON.parse(ended.payload).detail, /#7's gate hop at aaaaaaaaaaaa is already done or ended/u);
  assert.deepEqual([readGateHop(db, 7).state, readGateHop(db, 7).owner, readGateHop(db, 7).commit], ['driven', 'r2', NEW]);
  assert.equal(claim(db, 'r3', later + 1).job, 'gate:9:x', 'the next claim takes the other item\'s gate job');
});

test('clause 1: a live hop another runner holds still refuses the claim HOP_FENCED, and its job stays open [C7,#8352]', t => {
  const db = board(t);
  provideGateHopTable(leaseMs => ({ item, hop, now }, { name, actor }) => {
    if (name === 'create') return hop ? { refused: { code: 'HOP_EXISTS', message: 'exists' } } : { patch: { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: item.commit, digest: item.digest } } };
    if (hop.state === 'driven' && hop.owner !== actor && hop.leaseUntil >= now) return { refused: { code: 'HOP_HELD', message: `the hop is driven by ${hop.owner}` } };
    return { patch: { hop: { ...hop, state: 'driven', owner: actor, epoch: hop.epoch + 1, leaseUntil: now + leaseMs } } };
  });
  t.after(() => provideGateHopTable(null));
  claim(db, 'r1', 5000);
  offerJob(db, { id: 'gate:7:again', kind: 'gate', needs: [], item: 7, candidate: OLD, now: 5500 });
  assert.throws(() => claim(db, 'r2', 6000), { code: 'HOP_FENCED' });
  assert.equal(step(db, 'gate:7:again'), 'offered');
});
