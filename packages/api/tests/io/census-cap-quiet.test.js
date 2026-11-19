/** With census.jobsPerRunnerQuiet set, a runner holding no non-census job is offered that many census jobs; any other runner keeps census.jobsPerRunner [C7,#9500]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';

const boardWith = t => cellBoard(t, ':memory:').db;

/** Offer census test jobs in plan order with the cap and the quiet cap when given. */
function offerCensus(db, count, cap, quiet) {
  for (let at = 1; at <= count; at += 1) offerJob(db, { id: `test:census:${at}`, kind: 'test', priority: 'interactive', ...(cap ? { censusPerRunner: cap } : {}), ...(quiet ? { censusPerRunnerQuiet: quiet } : {}), now: at });
}

const take = (db, runner, now) => claimJob(db, { runner, cores: 10, jobs: 20, now });
const takeAll = (db, runner, from) => { const got = []; for (let now = from; now < from + 20; now += 1) { const claim = take(db, runner, now); if (!claim) break; got.push(claim.job); } return got; };

test('api.census-cap-quiet.census-jobsperrunnerquiet-set-census-jobsperrunner: clause 1: with census.jobsPerRunnerQuiet set to 8 and census.jobsPerRunner to 5, a runner holding no non-census job is offered its 6th census job and stops at 8 [C7,#9500]', t => {
  const db = boardWith(t);
  offerCensus(db, 12, 5, 8);
  const got = takeAll(db, 'kiln', 100);
  assert.equal(got.length, 8);
  assert.equal(got[5], 'test:census:6');
});

test('api.census-cap-quiet.runner-holds-non-census-job: clause 2: a runner that holds a non-census job stops at 5 census jobs [C7,#9500]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:item-1', kind: 'gate', now: 0 });
  assert.equal(take(db, 'kiln', 99)?.job, 'gate:item-1');
  offerCensus(db, 14, 5, 8);
  assert.equal(takeAll(db, 'kiln', 100).length, 5, 'one other job holds the runner to the plain cap');
  assert.equal(takeAll(db, 'mill', 200).length, 8, 'another runner holding only census jobs still gets the quiet cap');
});

test('api.census-cap-quiet.census-jobsperrunnerquiet-unset-cap-stays: clause 3: with census.jobsPerRunnerQuiet unset the cap stays 5 for every runner, and the offer is the one main writes [C7,#9500]', t => {
  const db = boardWith(t);
  offerCensus(db, 12, 5, null);
  assert.equal(takeAll(db, 'kiln', 100).length, 5);
  assert.equal(takeAll(db, 'mill', 200).length, 5);
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = 'test:census:1' AND job_step_name = 'offered'").get();
  assert.equal(Object.hasOwn(JSON.parse(row.job_step_payload), 'censusPerRunnerQuiet'), false);
  assert.throws(() => offerJob(db, { id: 'test:bad', kind: 'test', censusPerRunner: 5, censusPerRunnerQuiet: 0 }), { code: 'JOB_CENSUS_CAP' });
});
