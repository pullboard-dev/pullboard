/** With moves.shadow on, the gate-job writer records each job table shadow compare on the board; off, it runs no table [C7,#8381]. */
/** @pullboard-test-input packages/api/src/io/jobs.js packages/store/src/io/board/shadow-record.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { readShadow } from '../../../../store/index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { provideJobTable } from '../../../index.js';
import { releaseJob } from '../../../index.js';
import { renewJob } from '../../../index.js';

const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const LEASE_MS = 120_000;
// The moves cell sits above the api cell, so this stands in for the job table: it answers a renew by the holder as the table does, and refuses a stranger.
const holderRenews = leaseUntil => (snapshot, move) => (move.runner === snapshot.job?.claim?.runner && move.token === snapshot.job?.claim?.token
  ? { patch: { job: { ...snapshot.job, leaseUntil: leaseUntil ?? snapshot.now + LEASE_MS } } } : { refused: { code: 'JOB_LEASE_MOVED' } });

/** A board db with one claimed gate job; `shadow` is the db's stand-in for the moves.shadow machine setting. */
function claimed(t, shadow, decide) {
  const db = cellBoard(t, ':memory:').db;
  if (shadow !== undefined) db.movesShadow = shadow;
  provideJobTable(decide ?? null);
  t.after(() => provideJobTable(null));
  offerJob(db, { id: 'gate:record', kind: 'gate', needs: [], now: T0 });
  const claim = claimJob(db, { runner: 'r-holder', now: T0 });
  return { db, id: 'gate:record', token: claim.token };
}

test('clause 3: with moves.shadow off (the default) the job writer runs no table and records no compare [C7,#8381]', t => {
  const { db, id, token } = claimed(t, undefined, () => { throw new Error('the table must not run'); });
  renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000 });
  assert.equal(readShadow({ db }, 'job'), null);
});

test('clause 2: with moves.shadow on, a matching renew adds one compare and no disagreement to the job table\'s counts [C7,#8381]', t => {
  const { db, id, token } = claimed(t, true, holderRenews());
  renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000 });
  assert.throws(() => renewJob(db, { job: id, runner: 'r-other', token, now: T0 + 2_000 }), { code: 'JOB_LEASE_MOVED' });
  const counts = readShadow({ db }, 'job');
  assert.equal(counts.compared, 2, 'the renew and the stranger\'s refusal were each compared');
  assert.equal(counts.disagreed, 0, `the job table agreed: ${JSON.stringify(counts.last)}`);
});

test('clause 1: with moves.shadow on, a renew whose job table answer differs adds one disagreement naming the job and the field [C7,#8381]', t => {
  const { db, id, token } = claimed(t, true, holderRenews(T0 + 7));
  renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000 });
  releaseJob(db, { job: id, runner: 'r-holder', token, reason: 'stopping', now: T0 + 2_000 });
  const counts = readShadow({ db }, 'job');
  assert.equal(counts.compared, 2);
  assert.equal(counts.disagreed, 2);
  assert.deepEqual(counts.last.map(({ id: job, differs }) => ({ job, differs })), [{ job: id, differs: 'job.leaseUntil' }, { job: id, differs: 'job.owner' }]);
});

test('clause 1: a job table that throws is recorded as a disagreement and never refuses the runner\'s move [C7,#8381]', t => {
  const { db, id, token } = claimed(t, true, () => { throw new Error('broken table'); });
  assert.equal(renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000 }).renewed, true);
  const counts = readShadow({ db }, 'job');
  assert.equal(counts.disagreed, 1);
  assert.match(counts.last[0].differs, /^threw /u);
});
