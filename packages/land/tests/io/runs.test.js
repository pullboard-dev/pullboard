/** A hand landing and a batch landing run through the one finish sequence and are idempotent by their job id [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { jobView } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { toolingPin } from '../../../pin/index.js';
import { FINISH_STEPS } from '../../index.js';
import { LANDING_JOB_KIND } from '../../index.js';
import { batchLandingJobId } from '../../index.js';
import { landBatch } from '../../index.js';
import { landMerged } from '../../index.js';
import { mergedLandingJobId } from '../../index.js';

const refused = code => error => error.code === code;

/** A repo with a base and a landed commit on top, and a board's db. */
function landed(t) {
  const repo = cellRepo(t, {});
  repo.put('landed.txt', 'on trunk\n');
  const commit = repo.commitAll();
  return { repo: repo.root, base: repo.commit, commit, db: cellBoard(t, ':memory:').db };
}

test('land.runs.job-named-by-landing: landing jobs are named by what they land, so a repeat finds the same row [C7]', () => {
  assert.equal(LANDING_JOB_KIND, 'landing');
  assert.equal(mergedLandingJobId([4, 9], 'abc'), 'land:merged:4,9:abc');
  assert.equal(batchLandingJobId('b-7'), 'land:batch:b-7');
});

test('land.runs.hand-landing-one-merge: a hand landing runs the caller\'s check, record and publish around the one merge it answers, and pins the tooling [C7]', async t => {
  const land = landed(t);
  const seen = [];
  const result = await landMerged(land.db, { repo: land.repo, ids: [4, 9], commit: land.commit, base: land.base, owner: 'coordinator',
    check: () => { seen.push('check'); return { checked: true }; },
    record: context => { seen.push(['record', context.written.select]); return { board: 'recorded' }; },
    publish: () => { seen.push('publish'); } });
  assert.deepEqual(result.ran, FINISH_STEPS);
  assert.deepEqual([result.commit, result.ids, result.resumed], [land.commit, [4, 9], false]);
  assert.deepEqual(seen, ['check', ['record', { items: [4, 9], checked: true }], 'publish']);
  assert.deepEqual(result.written.prove, { verdict: 'green', proof: 'hand', receipt: result.written.prove.receipt, reused: false, code: 'NO_RECEIPT' });
  assert.deepEqual(toolingPin(land.repo)?.commit, land.commit);
  const job = jobView(land.db, mergedLandingJobId([4, 9], land.commit));
  assert.deepEqual([job.kind, job.item, job.candidate, job.base, job.step], [LANDING_JOB_KIND, 4, land.commit, land.base, 'done']);
});

test('land.runs.hand-landing-idempotent: a second hand landing of the same items and commit answers the same commit and records nothing again [C7]', async t => {
  const land = landed(t);
  let records = 0;
  const options = { repo: land.repo, ids: [4], commit: land.commit, owner: 'coordinator', record: () => { records += 1; return {}; } };
  await landMerged(land.db, options);
  const again = await landMerged(land.db, { ...options, owner: 'another' });
  assert.deepEqual([again.commit, again.ran, again.resumed, records], [land.commit, [], true, 1]);
  assert.equal(jobView(land.db, mergedLandingJobId([4], land.commit)).base, land.commit, 'without a base the landed commit stands on itself');
});

test('land.runs.hand-landing-resumes: a hand landing killed in its record resumes from the saved steps, and a refusing check writes nothing [C7]', async t => {
  const land = landed(t);
  let checks = 0;
  let attempts = 0;
  const options = { repo: land.repo, ids: [4], commit: land.commit, owner: 'coordinator',
    check: () => { checks += 1; return {}; },
    record: () => { attempts += 1; if (attempts === 1) throw new Error('killed'); return { attempts }; } };
  await assert.rejects(landMerged(land.db, options), /killed/u);
  const resumed = await landMerged(land.db, options);
  assert.deepEqual([resumed.ran, checks, attempts], [['record', 'publish'], 1, 2]);

  const refusing = landed(t);
  const refusal = Object.assign(new Error('not landable'), { code: 'NOT_LANDABLE' });
  await assert.rejects(landMerged(refusing.db, { repo: refusing.repo, ids: [1], commit: refusing.commit, owner: 'c', check: () => { throw refusal; }, record: () => ({}) }), error => error === refusal);
  assert.deepEqual(jobView(refusing.db, mergedLandingJobId([1], refusing.commit)).steps, []);
});

test('land.runs.hand-landing-refusals: a hand landing refuses no items, a short commit id, a missing record step and a lease held by another driver [C7]', async t => {
  const land = landed(t);
  const base = { repo: land.repo, ids: [4], commit: land.commit, owner: 'c', record: () => ({}) };
  await assert.rejects(landMerged(land.db, { ...base, ids: [] }), refused('LAND_ITEMS'));
  await assert.rejects(landMerged(land.db, { ...base, commit: 'abc123' }), refused('LAND_MERGE'));
  await assert.rejects(landMerged(land.db, { ...base, record: undefined }), refused('LAND_STEP_HANDLER'));
  const id = mergedLandingJobId([4], land.commit);
  await landMerged(land.db, { ...base, record: () => { throw new Error('killed'); } }).catch(() => {});
  takeJob(land.db, id, 'someone-else', { now: Date.now() + 600_000, leaseMs: 3_600_000 });
  await assert.rejects(landMerged(land.db, base), error => error.code === 'JOB_LEASED' && /held by someone-else/u.test(error.message));
});

test('land.runs.batch-landing-once: a batch landing records only a landed batch with a full tip, once, and answers the batch\'s own tip [C7]', async t => {
  const land = landed(t);
  assert.equal(await landBatch(land.db, { repo: land.repo, batch: { id: 'b1', tip: land.commit, state: 'open' }, owner: 'd' }), null);
  assert.equal(await landBatch(land.db, { repo: land.repo, batch: { id: 'b1', tip: 'short', state: 'landed' }, owner: 'd' }), null);
  assert.equal(await landBatch(land.db, { repo: land.repo, batch: null, owner: 'd' }), null);

  const batch = { id: 'b1', tip: land.commit, base: land.base, state: 'landed', items: [{ id: 3 }, { id: 5 }] };
  const first = await landBatch(land.db, { repo: land.repo, batch, owner: 'd' });
  assert.deepEqual(first, { commit: land.commit, ran: FINISH_STEPS });
  const job = jobView(land.db, batchLandingJobId('b1'));
  assert.deepEqual([job.item, job.candidate, job.base, job.step], [3, land.commit, land.base, 'done']);
  assert.deepEqual(job.steps.find(step => step.name === 'record').payload, { batch: 'b1', items: [3, 5] });
  assert.deepEqual(job.steps.find(step => step.name === 'prove').payload.proof, 'batch');
  assert.deepEqual(await landBatch(land.db, { repo: land.repo, batch, owner: 'other' }), { commit: land.commit, ran: [] }, 'a repeat is a no-op');
});
