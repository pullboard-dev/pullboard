/** Tests generated from the gate-job queue table: invariants every row keeps over thousands of seeded jobs, and metamorphic breaks that must refuse or must not matter [C7,#8239,#8252]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATE_JOB_KINDS } from '../../../index.js';
import { JOB_QUEUE_MOVES } from '../../../index.js';
import { jobEngine } from '../../../index.js';
import { releaseBackoff } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';

/** Stand-ins for the jobs lease rule and the api claim cap, which the wiring passes in. */
const LEASE_MS = 120_000;
const MAX = 12;
const { rules: RULES, table: TABLE } = jobEngine({ leaseMs: LEASE_MS, maxAttempts: MAX });
const NOW = 5_000_000;
const HELD = ['renew', 'release', 'progress', 'receipt', 'shards'];
const run = (snapshot, move) => runTable(TABLE, RULES, structuredClone(snapshot), structuredClone(move));

/** One seeded job and move: every step, live and lapsed leases, released claims, the claim cap, and callers with the right or a stale claim. */
function scenario(seed) {
  const g = seeded(seed);
  const step = g.pick(['queued', 'offered', 'claimed', 'claimed', 'claimed', 'done']);
  const attempt = step === 'offered' && g.int(2) ? 0 : g.pick([1, 2, 3, MAX - 1, MAX, MAX + 1]);
  const claim = step === 'claimed' || step === 'done' || g.int(3) === 0 ? { runner: g.pick(['r1', 'r1', 'r2']), token: g.pick(['t1', 't1', 't2']) } : null;
  const owner = step === 'claimed' && g.int(4) ? claim.runner : null;
  const leaseUntil = owner ? NOW + g.pick([-1, 0, 1, LEASE_MS]) : g.pick([0, NOW - 1, NOW + 30_000]);
  const job = g.int(15) === 0 ? null : { kind: g.pick(GATE_JOB_KINDS), step, attempt, owner, leaseUntil, claim };
  const name = g.int(40) === 0 ? 'nap' : g.pick(JOB_QUEUE_MOVES);
  const move = { name, runner: claim && g.int(3) ? claim.runner : g.pick(['r1', 'r2', 'r3']), token: claim && g.int(3) ? claim.token : g.pick(['t1', 't2', 't3']),
    ...(name === 'offer' ? { kind: g.int(10) ? g.pick(GATE_JOB_KINDS) : 'lint' } : {}), ...(name === 'release' && g.int(3) === 0 ? { free: true } : {}) };
  return { s: { job, now: NOW }, move };
}

const CASES = 20_000;
const results = Array.from({ length: CASES }, (_, seed) => {
  const { s, move } = scenario(seed + 1);
  return { seed: seed + 1, s, move, result: run(s, move) };
});
const ok = results.filter(c => !c.result.refused);
const after = (c) => c.result.patch.job;
const holds = (c) => Boolean(c.s.job?.claim) && c.s.job.claim.runner === c.move.runner && c.s.job.claim.token === c.move.token;

test('moves.job.rows-fire: generated: every guard and outcome row of the job table fires on some seeded case [C7,#8252]', () => {
  const fired = new Set(results.flatMap(c => (c.result.refused ? [c.result.refused.row] : c.result.via)));
  const rows = [...TABLE.guards.map(row => row.id), ...TABLE.outcomes.map(row => row.id)];
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
});

test('moves.job.outcome-by-move: generated: every accepted move leaves by an outcome row of its own move [C7,#8252]', () => {
  const rows = { offer: ['offer', 'offer-again'], claim: ['claim', 'runaway'], renew: ['renew', 'renew-lost'], release: ['release', 'release-free', 'release-lost'],
    progress: ['progress'], receipt: ['receipt', 'receipt-again'], shards: ['shards'] };
  for (const c of ok) assert.ok(rows[c.move.name].includes(c.result.via[0]), `seed ${c.seed}: ${c.move.name} left by ${c.result.via[0]}`);
  for (const c of ok.filter(each => each.move.name === 'shards')) assert.equal(c.s.job.kind, 'land', `seed ${c.seed}: shards for a ${c.s.job.kind} job`);
  for (const c of results.filter(each => each.move.name === 'shards' && each.s.job && each.s.job.step !== 'done' && each.s.job.kind !== 'land' && holds(each))) {
    assert.equal(c.result.refused?.code, 'JOB_NOT_LAND', `seed ${c.seed}`);
  }
});

test('moves.job.refusal-writes-nothing: generated: a refusal writes nothing and names a job code, a message and a next step [C7,#8252]', () => {
  const codes = new Set(TABLE.guards.map(row => row.code));
  for (const c of results.filter(each => each.result.refused)) {
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}`);
    assert.ok(codes.has(c.result.refused.code) && c.result.refused.message && c.result.refused.next, `seed ${c.seed}`);
  }
});

test('moves.job.current-claim-only: generated: only the runner and token of the current claim renew, release, post progress or a receipt, or ask for shards [C7,#8252]', () => {
  for (const c of results.filter(each => HELD.includes(each.move.name) && each.s.job)) {
    if (!holds(c)) assert.equal(c.result.refused?.code, 'JOB_LEASE_MOVED', `seed ${c.seed}: a stale ${c.move.name} got through`);
  }
  for (const c of ok.filter(each => HELD.includes(each.move.name))) assert.ok(holds(c), `seed ${c.seed}`);
});

test('moves.job.claim-lapsed: generated: a claim is taken only from an offered or claimed job whose lease has lapsed, counts one attempt and hands the caller the lease [C7,#8252]', () => {
  for (const c of ok.filter(each => each.move.name === 'claim')) {
    const before = c.s.job;
    assert.ok(['offered', 'claimed'].includes(before.step) && before.leaseUntil < c.s.now, `seed ${c.seed}`);
    if (before.attempt >= MAX) {
      assert.deepEqual([c.result.via, after(c), c.result.events], [['runaway'], { ...before, step: 'done', owner: null, leaseUntil: 0 }, [{ kind: 'job.step', step: 'runaway', attempt: before.attempt }]], `seed ${c.seed}`);
      continue;
    }
    assert.deepEqual(after(c), { ...before, step: 'claimed', attempt: before.attempt + 1, owner: c.move.runner, leaseUntil: c.s.now + LEASE_MS, claim: { runner: c.move.runner, token: c.move.token } }, `seed ${c.seed}`);
    assert.deepEqual(c.result.events, [{ kind: 'job.step', step: 'claimed', attempt: before.attempt + 1, runner: c.move.runner }], `seed ${c.seed}`);
  }
  for (const c of results.filter(each => each.move.name === 'claim' && each.s.job && each.s.job.step !== 'done' && each.s.job.leaseUntil >= NOW)) {
    assert.ok(c.result.refused, `seed ${c.seed}: a live lease was claimed`);
  }
});

test('moves.job.done-stays-done: generated: no move after the receipt brings a done job back, and no move changes its kind or claim token except a claim [C7,#8252]', () => {
  for (const c of ok.filter(each => each.s.job)) {
    if (c.s.job.step === 'done') assert.equal(after(c).step, 'done', `seed ${c.seed}`);
    assert.equal(after(c).kind, c.s.job.kind, `seed ${c.seed}`);
    if (c.move.name !== 'claim') assert.deepEqual(after(c).claim, c.s.job.claim, `seed ${c.seed}`);
    assert.ok(after(c).attempt === c.s.job.attempt || (c.result.via[0] === 'claim' && after(c).attempt === c.s.job.attempt + 1), `seed ${c.seed}`);
  }
});

test('moves.job.release-backoff: generated: a release by the owner backs off by attempt or frees at once; one that lost the lease, a lost renew and a repeat receipt change nothing [C7,#8252]', () => {
  for (const c of ok.filter(each => ['release', 'renew', 'receipt'].includes(each.move.name))) {
    const before = c.s.job, owns = before.owner === c.move.runner;
    if (c.move.name === 'release' && owns) {
      assert.deepEqual([after(c).owner, after(c).leaseUntil], [null, c.move.free ? 0 : c.s.now + releaseBackoff(before.attempt)], `seed ${c.seed}`);
    } else if (c.move.name === 'renew' && owns) {
      assert.equal(after(c).leaseUntil, c.s.now + LEASE_MS, `seed ${c.seed}`);
    } else if (c.move.name === 'receipt' && before.step !== 'done') {
      assert.deepEqual([after(c).step, after(c).owner, after(c).leaseUntil], ['done', null, 0], `seed ${c.seed}`);
    } else {
      assert.deepEqual([after(c), c.result.events], [before, []], `seed ${c.seed}: ${c.result.via[0]} wrote`);
    }
  }
  for (let attempt = 1; attempt <= 30; attempt++) {
    assert.equal(releaseBackoff(attempt), Math.min(30_000 * 2 ** (Math.min(attempt, 20) - 1), 300_000), `attempt ${attempt}`);
    assert.ok(releaseBackoff(attempt + 1) >= releaseBackoff(attempt));
  }
});

test('moves.job.offer-once: generated: an offer makes a fresh offered job once, and offering it again changes nothing [C7,#8252]', () => {
  for (const c of ok.filter(each => each.move.name === 'offer')) {
    if (c.s.job) assert.deepEqual([after(c), c.result.events], [c.s.job, []], `seed ${c.seed}`);
    else assert.deepEqual(after(c), { kind: c.move.kind, step: 'offered', attempt: 0, owner: null, leaseUntil: 0, claim: null }, `seed ${c.seed}`);
  }
});

test('moves.job.deterministic: generated: the table is deterministic and reads its snapshot without changing it [C7,#8252]', () => {
  for (const c of results.slice(0, 2000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.move);
    assert.deepEqual(runTable(TABLE, RULES, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.move], `seed ${c.seed}`);
  }
});

test('moves.job.lease-moved: metamorphic: break the runner or the token of an accepted held move and it is refused JOB_LEASE_MOVED [C7,#8252]', () => {
  const held = ok.filter(c => HELD.includes(c.move.name));
  assert.ok(held.length > 200, `only ${held.length} accepted held moves`);
  for (const c of held) {
    for (const move of [{ ...c.move, runner: 'r9' }, { ...c.move, token: 't9' }]) {
      assert.equal(run(c.s, move).refused?.code, 'JOB_LEASE_MOVED', `seed ${c.seed}: ${JSON.stringify(move)}`);
    }
  }
});

test('moves.job.clock-shift: metamorphic: shifting the clock and every lease by the same amount changes no outcome; moving the clock to the lease end frees a claim [C7,#8252]', () => {
  const shift = (s, by) => ({ now: s.now + by, job: s.job && { ...s.job, leaseUntil: s.job.leaseUntil === 0 ? 0 : s.job.leaseUntil + by } });
  for (const c of results.filter(each => each.s.job?.leaseUntil !== 0).slice(0, 4000)) {
    for (const by of [-60_000, 1, 3_600_000]) {
      const moved = run(shift(c.s, by), c.move);
      assert.deepEqual(moved.refused?.row ?? moved.via, c.result.refused?.row ?? c.result.via, `seed ${c.seed}: a ${by} ms shift changed the outcome`);
    }
  }
  for (const c of results.filter(each => each.move.name === 'claim' && each.result.refused?.row === 'free')) {
    assert.ok(!run({ ...c.s, now: c.s.job.leaseUntil + 1 }, c.move).refused, `seed ${c.seed}: a lapsed lease is still held`);
    assert.equal(run({ ...c.s, now: c.s.job.leaseUntil }, c.move).refused?.row, 'free', `seed ${c.seed}: the lease ended early`);
  }
});

test('moves.job.rule-inputs: generated: the job engine refuses JOB_RULE without a positive lease and a whole claim cap of at least one [C7,#8252]', () => {
  for (const queue of [{ leaseMs: 0, maxAttempts: 1 }, { leaseMs: Number.NaN, maxAttempts: 1 }, { leaseMs: Number.POSITIVE_INFINITY, maxAttempts: 1 }, { leaseMs: 1, maxAttempts: 0 }, { leaseMs: 1, maxAttempts: 1.5 }, {}]) {
    assert.throws(() => jobEngine(queue), { code: 'JOB_RULE' }, JSON.stringify(queue));
  }
  assert.equal(typeof jobEngine({ leaseMs: 1, maxAttempts: 1 }).table, 'object');
  const one = jobEngine({ leaseMs: 1, maxAttempts: 1 });
  const claimed = { job: { kind: 'gate', step: 'claimed', attempt: 1, owner: null, leaseUntil: 0, claim: null }, now: NOW };
  assert.deepEqual(runTable(one.table, one.rules, claimed, { name: 'claim', runner: 'r1', token: 't1' }).via, ['runaway']);
});
