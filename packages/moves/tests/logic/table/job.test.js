/** The gate-job queue table: every row (offer, claim, renew, release, progress, receipt, shards) and its codes JOB_LEASE_MOVED, JOB_DONE, JOB_MISSING and JOB_NOT_LAND, with generated cases [C7,#8239]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATE_JOB_KINDS } from '../../../index.js';
import { JOB_QUEUE_MOVES } from '../../../index.js';
import { jobEngine } from '../../../index.js';
import { releaseBackoff } from '../../../index.js';
import { runTable } from '../../../index.js';
import { tableCases } from '../../../index.js';

/** Stand-ins for the jobs lease rule and the api claim cap, which the wiring passes in. */
const LEASE_MS = 120_000;
const MAX = 12;
const { rules: RULES, table: TABLE } = jobEngine({ leaseMs: LEASE_MS, maxAttempts: MAX });
const NOW = 5_000_000;
const job = (over = {}) => ({ kind: 'gate', step: 'claimed', attempt: 1, owner: 'r1', leaseUntil: NOW + LEASE_MS, claim: { runner: 'r1', token: 't1' }, ...over });
const snap = (over = {}) => ({ job: job(), now: NOW, ...over });
const ask = (name, more = {}) => ({ name, runner: 'r1', token: 't1', ...more });
const run = (snapshot, move) => runTable(TABLE, RULES, snapshot, move);
const refusal = (snapshot, move) => run(snapshot, move).refused?.code;

test('offer creates an offered job once, and offering it again changes nothing [C7,#8239]', () => {
  const made = run({ job: null, now: NOW }, { name: 'offer', kind: 'land' });
  assert.deepEqual(made.via, ['offer']);
  assert.deepEqual(made.patch.job, { kind: 'land', step: 'offered', attempt: 0, owner: null, leaseUntil: 0, claim: null });
  assert.deepEqual(made.events, [{ kind: 'job.step', step: 'offered' }]);
  const again = run(snap(), { name: 'offer', kind: 'gate' });
  assert.deepEqual([again.via, again.patch.job, again.events], [['offer-again'], job(), []]);
  assert.equal(refusal({ job: null, now: NOW }, { name: 'offer', kind: 'bogus' }), 'JOB_KIND');
  assert.deepEqual(GATE_JOB_KINDS, ['gate', 'gate-shard', 'land', 'review']);
});

test('claim takes an offered or lapsed job, hands out the token and counts the attempt; a live lease, a queued or done job and a missing job refuse [C7,#8239]', () => {
  const offered = snap({ job: job({ step: 'offered', attempt: 0, owner: null, leaseUntil: 0, claim: null }) });
  const taken = run(offered, ask('claim', { runner: 'r2', token: 't2' }));
  assert.deepEqual(taken.via, ['claim']);
  assert.deepEqual(taken.patch.job, job({ attempt: 1, owner: 'r2', leaseUntil: NOW + LEASE_MS, claim: { runner: 'r2', token: 't2' } }));
  assert.deepEqual(taken.events, [{ kind: 'job.step', step: 'claimed', attempt: 1, runner: 'r2' }]);
  assert.deepEqual(run(snap({ job: job({ leaseUntil: NOW - 1 }) }), ask('claim', { runner: 'r2', token: 't2' })).via, ['claim']);
  assert.equal(run(snap({ job: job({ leaseUntil: NOW - 1 }) }), ask('claim', { runner: 'r2', token: 't2' })).patch.job.attempt, 2);
  assert.equal(refusal(snap({ job: job({ leaseUntil: NOW }) }), ask('claim', { runner: 'r2', token: 't2' })), 'JOB_HELD', 'a lease that ends at now is still held; it lapses only strictly before now');
  assert.equal(refusal(snap({ job: job({ leaseUntil: NOW + 1 }) }), ask('claim', { runner: 'r2', token: 't2' })), 'JOB_HELD');
  assert.equal(refusal(snap({ job: job({ step: 'queued', owner: null, leaseUntil: 0, claim: null }) }), ask('claim')), 'JOB_NOT_OFFERED');
  assert.equal(refusal(snap({ job: job({ step: 'done', owner: null, leaseUntil: 0 }) }), ask('claim')), 'JOB_DONE');
  assert.equal(refusal({ job: null, now: NOW }, ask('claim')), 'JOB_MISSING');
});

test('the twelfth claim ends the job as a runaway instead of handing it out [C7,#8239]', () => {
  const lapsed = snap({ job: job({ attempt: MAX, leaseUntil: NOW - 1 }) });
  const ended = run(lapsed, ask('claim', { runner: 'r2', token: 't2' }));
  assert.deepEqual([ended.via, ended.patch.job.step, ended.patch.job.owner, ended.events], [['runaway'], 'done', null, [{ kind: 'job.step', step: 'runaway', attempt: MAX }]]);
  assert.equal(run(snap({ job: job({ attempt: MAX - 1, leaseUntil: NOW - 1 }) }), ask('claim')).via[0], 'claim');
});

test('renew extends the holder, reads false for a released claim, and refuses JOB_LEASE_MOVED for any other token or runner, even after the lease lapsed [C7,#8239]', () => {
  const later = NOW + 10 * LEASE_MS;
  const renewed = run(snap({ now: later }), ask('renew'));
  assert.deepEqual([renewed.via, renewed.patch.job.leaseUntil], [['renew'], later + LEASE_MS]);
  assert.deepEqual(run(snap({ job: job({ owner: null, leaseUntil: NOW + 5 }) }), ask('renew')).via, ['renew-lost']);
  assert.equal(refusal(snap(), ask('renew', { token: 'other' })), 'JOB_LEASE_MOVED');
  assert.equal(refusal(snap(), ask('renew', { runner: 'r2' })), 'JOB_LEASE_MOVED');
  assert.equal(refusal(snap({ job: job({ claim: null }) }), ask('renew')), 'JOB_LEASE_MOVED');
  assert.equal(refusal({ job: null, now: NOW }, ask('renew')), 'JOB_MISSING');
});

test('release backs the job off 30 s doubling to 5 minutes, or frees it at once when asked and free, and is a no-op for a claim that lost the lease [C7,#8239]', () => {
  const backed = run(snap({ job: job({ attempt: 3 }) }), ask('release'));
  assert.deepEqual([backed.via, backed.patch.job.owner, backed.patch.job.leaseUntil, backed.events], [['release'], null, NOW + 120_000, [{ kind: 'job.step', step: 'released', attempt: 3, runner: 'r1' }]]);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20, 99].map(releaseBackoff), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000]);
  const free = run(snap(), ask('release', { free: true }));
  assert.deepEqual([free.via, free.patch.job.owner, free.patch.job.leaseUntil, free.events], [['release-free'], null, 0, []]);
  assert.deepEqual(run(snap({ job: job({ owner: null, leaseUntil: NOW + 5 }) }), ask('release')).via, ['release-lost']);
  assert.equal(refusal(snap(), ask('release', { token: 'x' })), 'JOB_LEASE_MOVED');
});

test('progress records for the holder and refuses JOB_DONE once the receipt is in; a receipt ends the job, and the same receipt again changes nothing [C7,#8239]', () => {
  const live = run(snap(), ask('progress'));
  assert.deepEqual([live.via, live.patch.job, live.events], [['progress'], job(), [{ kind: 'job.step', step: 'progress', attempt: 1 }]]);
  const done = job({ step: 'done', owner: null, leaseUntil: 0 });
  assert.equal(refusal(snap({ job: done }), ask('progress')), 'JOB_DONE');
  assert.equal(refusal(snap(), ask('progress', { token: 'x' })), 'JOB_LEASE_MOVED');
  const receipt = run(snap(), ask('receipt'));
  assert.deepEqual([receipt.via, receipt.patch.job.step, receipt.patch.job.owner, receipt.patch.job.leaseUntil, receipt.events], [['receipt'], 'done', null, 0, [{ kind: 'job.step', step: 'receipt', attempt: 1, runner: 'r1' }]]);
  const lapsed = run(snap({ job: job({ leaseUntil: NOW - 1 }) }), ask('receipt'));
  assert.deepEqual(lapsed.via, ['receipt'], 'a lapsed holder still posts while no one claimed since');
  assert.deepEqual([run(snap({ job: done }), ask('receipt')).via, run(snap({ job: done }), ask('receipt')).events], [['receipt-again'], []]);
  assert.equal(refusal(snap({ job: done }), ask('receipt', { runner: 'r2' })), 'JOB_LEASE_MOVED');
});

test('a shards ask is for the land job\'s own runner: another kind is JOB_NOT_LAND, a stale claim JOB_LEASE_MOVED, a missing job JOB_MISSING [C7,#8239]', () => {
  assert.deepEqual(run(snap({ job: job({ kind: 'land' }) }), ask('shards')).via, ['shards']);
  assert.equal(refusal(snap(), ask('shards')), 'JOB_NOT_LAND');
  assert.equal(refusal(snap({ job: job({ kind: 'land' }) }), ask('shards', { token: 'x' })), 'JOB_LEASE_MOVED');
  assert.equal(refusal({ job: null, now: NOW }, ask('shards')), 'JOB_MISSING');
  assert.equal(refusal(snap(), { name: 'sweep' }), 'JOB_ACTION');
  assert.equal(JOB_QUEUE_MOVES.length, 7);
});

test('the job queue needs its lease and claim cap handed in [C7,#8239]', () => {
  assert.throws(() => jobEngine({ leaseMs: 0, maxAttempts: 12 }), { code: 'JOB_RULE' });
  assert.throws(() => jobEngine({ leaseMs: LEASE_MS }), { code: 'JOB_RULE' });
  const short = jobEngine({ leaseMs: 7, maxAttempts: 1 });
  assert.equal(runTable(short.table, short.rules, snap({ job: job({ step: 'offered', attempt: 0, owner: null, leaseUntil: 0, claim: null }) }), ask('claim')).patch.job.leaseUntil, NOW + 7);
});

/** One generated case per seed: a move over a job in one of the states the queue reaches, with a break for each guard it should meet. */
function generate(g) {
  const name = g.pick(JOB_QUEUE_MOVES);
  const kind = name === 'shards' ? g.pick(['land', 'gate']) : 'gate';
  const state = g.pick(['offered', 'held', 'lapsed', 'released', 'done', 'spent']);
  const base = {
    offered: job({ kind, step: 'offered', attempt: 0, owner: null, leaseUntil: 0, claim: null }),
    held: job({ kind }),
    lapsed: job({ kind, leaseUntil: NOW - 1 }),
    released: job({ kind, owner: null, leaseUntil: NOW + 30_000 }),
    done: job({ kind, step: 'done', owner: null, leaseUntil: 0 }),
    spent: job({ kind, attempt: MAX, leaseUntil: NOW - 1 }),
  }[state];
  const move = name === 'offer' ? { name, kind: 'gate' } : { name, runner: g.pick(['r1', 'r2']), token: g.pick(['t1', 't2']), free: g.int(2) === 0 };
  const breaks = {
    knownMove: (s, m) => ({ snapshot: s, move: { ...m, name: 'sweep' } }),
    knownKind: (s) => ({ snapshot: s, move: { name: 'offer', kind: 'bogus' } }),
    exists: (s, m) => ({ snapshot: { ...s, job: null }, move: m }),
    holdsClaim: (s, m) => ({ snapshot: s, move: { ...m, token: 'stale' } }),
    unfinished: (s, m) => ({ snapshot: { ...s, job: { ...s.job, step: 'done' } }, move: m }),
    free: (s, m) => ({ snapshot: { ...s, job: { ...s.job, leaseUntil: s.now + 1 } }, move: m }),
    offered: (s, m) => ({ snapshot: { ...s, job: { ...s.job, step: 'queued' } }, move: m }),
    landJob: (s, m) => ({ snapshot: { ...s, job: { ...s.job, kind: 'gate' } }, move: m }),
  };
  return { snapshot: { job: name === 'offer' && g.int(2) === 0 ? null : base, now: NOW }, move, breaks };
}

test('generated cases reach every job row and never write while refusing [C7,#8239]', () => {
  const report = tableCases(TABLE, RULES, generate, { seed: 8239, count: 1500 });
  assert.deepEqual(report.writingRefusals, []);
  assert.deepEqual(report.unreached.outcomes, []);
});
