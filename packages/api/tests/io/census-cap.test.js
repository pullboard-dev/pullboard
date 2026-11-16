/** A census job offered under census.jobsPerRunner waits while its runner holds that many census jobs; other jobs and the default are as before [C7,#9136]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';
import { postReceipt } from '../../index.js';
import { describeSetting } from '../../../config/index.js';

const boardWith = t => cellBoard(t, ':memory:').db;

/** Offer census test jobs in plan order (heaviest first), each with the cap when one is given. */
function offerCensus(db, count, cap) {
  for (let at = 1; at <= count; at += 1) offerJob(db, { id: `test:census:${at}`, kind: 'test', priority: 'interactive', ...(cap ? { censusPerRunner: cap } : {}), now: at });
}

const take = (db, runner, now) => claimJob(db, { runner, cores: 10, jobs: 10, now });

test('clause 1: with census.jobsPerRunner set to N, a runner holding N census test jobs is offered no further census job until one ends, while non-census jobs are offered as on main [C7,#9136]', t => {
  const db = boardWith(t);
  offerCensus(db, 6, 2);
  const first = take(db, 'kiln', 100), second = take(db, 'kiln', 101);
  assert.deepEqual([first.job, second.job], ['test:census:1', 'test:census:2']);
  assert.equal(take(db, 'kiln', 102), null, 'a third census job waits on this runner');
  assert.equal(take(db, 'mill', 103)?.job, 'test:census:3', 'another runner still takes census jobs');
  offerJob(db, { id: 'test:agent-run', kind: 'test', priority: 'interactive', now: 50 });
  offerJob(db, { id: 'gate:item-1', kind: 'gate', now: 51 });
  assert.deepEqual([take(db, 'kiln', 104)?.job, take(db, 'kiln', 105)?.job].sort(), ['gate:item-1', 'test:agent-run'], 'a runner at its census cap still takes every other job');
  postReceipt(db, { job: first.job, runner: 'kiln', token: first.token, receipt: { status: 0 }, now: 106 });
  assert.equal(take(db, 'kiln', 107)?.job, 'test:census:4', 'an ended census job frees its place');
  assert.equal(take(db, 'kiln', 108), null);
});

test('clause 2: with census.jobsPerRunner unset (the default), offers are exactly as on main, and census.jobsPerRunner is a described setting [C7,#9136]', t => {
  const db = boardWith(t);
  offerCensus(db, 6, null);
  const taken = [100, 101, 102, 103, 104, 105].map(now => take(db, 'kiln', now)?.job);
  assert.deepEqual(taken, [1, 2, 3, 4, 5, 6].map(at => `test:census:${at}`), 'one runner takes every census job its slots allow');
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = 'test:census:1' AND job_step_name = 'offered'").get();
  assert.equal(Object.hasOwn(JSON.parse(row.job_step_payload), 'censusPerRunner'), false, 'the offered row is the one main writes');
  assert.throws(() => offerJob(db, { id: 'test:bad', kind: 'test', censusPerRunner: 0 }), { code: 'JOB_CENSUS_CAP' });
  const described = describeSetting('census.jobsPerRunner');
  assert.ok(described, 'census.jobsPerRunner has a description');
  assert.equal(described.unit, 'count');
  assert.match(described.description, /runner slot counts are unchanged/u);
});

test('clause 3: under the cap, census jobs are still offered heaviest first [C7,#9136]', t => {
  const db = boardWith(t);
  // The census offers its plan heaviest first; job 1 is the heaviest.
  offerCensus(db, 5, 1);
  const order = [];
  for (let now = 100; order.length < 5 && now < 200; now += 1) {
    for (const runner of ['kiln', 'mill']) {
      const claim = take(db, runner, now);
      if (!claim) continue;
      order.push(claim.job);
      postReceipt(db, { job: claim.job, runner, token: claim.token, receipt: { status: 0 }, now });
    }
  }
  assert.deepEqual(order, [1, 2, 3, 4, 5].map(at => `test:census:${at}`));
});
