/** Runner jobs carry a priority class set at offer; a claim takes the highest class first, keeps each class's reserve, and with no reserve claims as before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { claimableJobs } from '../../index.js';
import { createJob } from '../../index.js';
import { takeJob } from '../../index.js';
import { writeStep } from '../../index.js';

const RESERVE = { interactive: 0.3, gate: 0.3, landing: 0.2, background: 0.1 };

/** Offer one job as the enqueuing command does: its kind and the class it names. */
function offer(db, id, kind, priority, now) {
  createJob(db, { id, kind, now });
  writeStep(db, id, 'offered', { needs: [], priority }, { now });
}

/** A board whose queue holds, oldest first, a background sweep, a landing, a gate and an agent's test run. */
function mixedQueue(t) {
  const { db } = cellBoard(t, ':memory:');
  offer(db, 'main-test:1', 'main-test', 'background', 1);
  offer(db, 'land:1', 'land', 'landing', 2);
  offer(db, 'gate:1', 'gate', 'gate', 3);
  offer(db, 'test:1', 'test', 'interactive', 4);
  return db;
}

/** One claim by runner r1: the first job in claim order, leased to it; null when nothing is open. */
function claim(db, { reserve = null, slots = null } = {}) {
  const [first] = claimableJobs(db, { runner: 'r1', now: 10, limit: 500, reserve, slots });
  if (!first) return null;
  assert.equal(takeJob(db, first.row.job_id, 'r1', { now: 10 }).taken, true);
  return first.row.job_id;
}

test('jobs.priority.class-order: a runner claims the highest priority class first: interactive, gate, landing, then background [C7]', t => {
  const db = mixedQueue(t);
  assert.deepEqual([1, 2, 3, 4].map(() => claim(db, { reserve: {}, slots: 8 })), ['test:1', 'gate:1', 'land:1', 'main-test:1']);
  assert.equal(claim(db, { reserve: {}, slots: 8 }), null, 'the queue is empty once every class is taken');
});

test('jobs.priority.reserved-slot: a class with a reserve still gets its reserved slot under full load [C7]', t => {
  const queue = () => {
    const { db } = cellBoard(t, ':memory:');
    for (let n = 1; n <= 6; n += 1) offer(db, `test:${n}`, 'test', 'interactive', n);
    offer(db, 'main-test:1', 'main-test', 'background', 9);
    return db;
  };
  // A 4-slot runner: interactive outranks background for three slots, then the last free slot is background's reserve.
  const reserved = queue();
  assert.deepEqual([1, 2, 3, 4].map(() => claim(reserved, { reserve: RESERVE, slots: 4 })), ['test:1', 'test:2', 'test:3', 'main-test:1']);
  // With no background reserve, the same full runner gives every slot to interactive runs.
  const unreserved = queue();
  assert.deepEqual([1, 2, 3, 4].map(() => claim(unreserved, { reserve: { interactive: 0.5 }, slots: 4 })), ['test:1', 'test:2', 'test:3', 'test:4']);
});

test('jobs.priority.default-order: with no priority setting the claim order is landings, then test and main-test runs by age, then the rest by age [C7]', t => {
  const db = mixedQueue(t);
  assert.deepEqual([1, 2, 3, 4].map(() => claim(db, { slots: 4 })), ['land:1', 'main-test:1', 'test:1', 'gate:1']);
});

test('jobs.priority.main-test-before-shards: with an older gate-shard row and a newer main-test row offered, the plain order offers the main-test row first [C7]', t => {
  const { db } = cellBoard(t, ':memory:');
  offer(db, 'shard:1', 'gate-shard', 'gate', 1);
  offer(db, 'main-test:2', 'main-test', 'background', 2);
  assert.deepEqual([1, 2].map(() => claim(db)), ['main-test:2', 'shard:1']);
});

test('jobs.priority.land-still-first: a land row still comes before a main-test row [C7]', t => {
  const { db } = cellBoard(t, ':memory:');
  offer(db, 'main-test:1', 'main-test', 'background', 1);
  offer(db, 'land:2', 'land', 'landing', 2);
  assert.deepEqual([1, 2].map(() => claim(db)), ['land:2', 'main-test:1']);
});

/** Offer one job with a payload padded past 40 KB, as a gate shard's offer is. */
function bulkyOffer(db, id, kind, priority, now) {
  createJob(db, { id, kind, now });
  writeStep(db, id, 'offered', { needs: [], priority, pad: 'x'.repeat(41_000) }, { now });
}

/** The claim scan as it ran before: one join carrying every offered payload through the sorter, then the runnable filter. */
function beforeIds(db, { now, limit, reserve, runnable }) {
  const rank = "CASE json_extract(step.job_step_payload, '$.priority') WHEN 'interactive' THEN 0 WHEN 'gate' THEN 1 WHEN 'landing' THEN 2 ELSE 3 END";
  const plain = "CASE job.job_kind WHEN 'land' THEN 0 WHEN 'test' THEN 1 WHEN 'main-test' THEN 1 ELSE 2 END";
  const pushFirst = "CASE WHEN job.job_kind = 'gate-shard' AND job.job_id LIKE 'push:%' THEN 0 ELSE 1 END";
  const rows = db.prepare(`SELECT job.job_id, job.job_kind, step.job_step_payload FROM job JOIN job_step AS step
    ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0
    WHERE job.job_step IN ('offered', 'claimed') AND job.job_lease_until < ? ORDER BY ${pushFirst}, ${reserve ? rank : plain}, job.job_created, job.job_id LIMIT ?`).all(now, limit);
  return rows.filter(row => runnable(row, JSON.parse(row.job_step_payload))).map(row => row.job_id);
}

/** A board holding 600 offered rows of 41 KB payloads: land, test, push gate-shard and background rows in turn. */
function bulkyBoard(t) {
  const { db } = cellBoard(t, ':memory:');
  const kinds = [['land', 'landing'], ['test', 'interactive'], ['gate-shard', 'gate'], ['main-test', 'background']];
  for (let n = 0; n < 600; n += 1) {
    const [kind, priority] = kinds[n % 4];
    bulkyOffer(db, kind === 'gate-shard' && n % 8 === 2 ? `push:${n}` : `${kind}:${n}`, kind, priority, n + 1);
  }
  return db;
}

test('jobs.priority.ids-first: the claim scan orders and limits job ids first, then reads payloads only for the rows it returns, in the order it had before [C7]', t => {
  const db = bulkyBoard(t);
  const sqls = [];
  let payloadReads = 0;
  const spy = { prepare: sql => {
    const statement = db.prepare(sql);
    if (/FROM job JOIN job_step/u.test(sql)) sqls.push(sql);
    if (/^SELECT job_step_payload FROM job_step/u.test(sql)) return { get: (...args) => { payloadReads += 1; return statement.get(...args); } };
    return statement;
  } };
  const runnable = () => true;
  const got = claimableJobs(spy, { runner: 'r1', now: 1_000, limit: 50, runnable });
  assert.deepEqual(got.map(({ row }) => row.job_id), beforeIds(db, { now: 1_000, limit: 50, reserve: null, runnable }));
  assert.equal(got.length, 50);
  assert.equal(payloadReads, 50, 'a payload is read for each returned row only, not for the 600 offered rows');
  assert.ok(sqls.length > 0 && sqls.every(sql => !/job_step_payload/u.test(sql)), 'the ordering scan never selects a payload');
  assert.ok(got.every(({ offer }) => offer.pad.length === 41_000), 'each row carries its parsed offer');
});

test('jobs.priority.ids-first-filter: with 600 offered rows whose payloads exceed 40 KB, the runnable filter, push-first order and reserve order are unchanged [C7]', t => {
  const db = bulkyBoard(t);
  const runnable = (row, offer) => offer.priority !== 'interactive' || row.job_id !== 'test:1';
  const plain = claimableJobs(db, { runner: 'r1', now: 1_000, limit: 500, runnable });
  assert.deepEqual(plain.map(({ row }) => row.job_id), beforeIds(db, { now: 1_000, limit: 500, reserve: null, runnable }));
  assert.ok(!plain.some(({ row }) => row.job_id === 'test:1'), 'the runnable filter drops its row');
  assert.ok(plain.length > 0 && plain[0].row.job_id.startsWith('push:'), 'a push shard goes first');
  const reserved = claimableJobs(db, { runner: 'r1', now: 1_000, limit: 500, reserve: {}, slots: 8, runnable });
  const before = beforeIds(db, { now: 1_000, limit: 500, reserve: {}, runnable });
  assert.deepEqual([...reserved.map(({ row }) => row.job_id)].sort(), [...before].sort(), 'the same rows come back');
  const rank = { interactive: 0, gate: 1, landing: 2, background: 3 };
  const rest = reserved.filter(({ row }) => !row.job_id.startsWith('push:'));
  assert.ok(reserved.slice(0, reserved.length - rest.length).every(({ row }) => row.job_id.startsWith('push:')), 'push shards stay first under a reserve');
  assert.deepEqual(rest.map(({ offer }) => rank[offer.priority]), rest.map(({ offer }) => rank[offer.priority]).sort((a, b) => a - b), 'the rest follow class order');
});
