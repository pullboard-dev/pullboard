/** Tests generated from the landing lease table: invariants every row keeps over thousands of seeded states, and metamorphic breaks that must refuse or must not matter [C7,#8164,#8252]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEASE_MOVES } from '../../../index.js';
import { leaseEngine } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';

/** Stand-ins for the store's lease rule and entry check, which the wiring passes in. */
const LEASE_MS = 120_000;
const valid = (entry) => /^[a-f0-9-]{36}$/u.test(entry?.token ?? '') && Number.isFinite(Date.parse(entry.until)) && Number.isFinite(Date.parse(entry.since));
const { rules: RULES, table: TABLE } = leaseEngine({ leaseMs: LEASE_MS, valid });
const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const HOLDER_MOVES = ['renew', 'bind', 'assert'];
const token = (n) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).repeat(12)}`;
const iso = (ms) => new Date(ms).toISOString();
const run = (snapshot, move) => runTable(TABLE, RULES, structuredClone(snapshot), structuredClone(move));

/** The expiry rule in words, written here apart from the table: a lineage-bound entry on a modern board lapses with the lineage, any other at its deadline. */
const lapsed = (s, entry) => (s.modern && entry.lineage !== null ? entry.lineage !== s.lineage : Date.parse(entry.until) <= s.now);

/** An entry for lander n with a deadline `ahead` ms from now, `lineage` and its identity. */
function entry(g, n, s) {
  const ahead = g.pick([-LEASE_MS, -1, 0, 1, 1000, LEASE_MS]);
  return { token: token(n), branch: 'trunk', pid: 100 + n, label: `coordinator landing ${token(n).slice(0, 8)}`, lineage: g.pick([null, null, 'a', 'b']),
    since: iso(s.now - 5000), until: iso(s.now + ahead), ...(g.int(4) === 0 ? { guardianPid: 70 + n } : {}) };
}

/** One seeded state and move, biased so every row is reached: free, live, lapsed and lineage-bound holders, waiting lines, heartbeats and fence mismatches. */
function scenario(seed) {
  const g = seeded(seed);
  const s = { now: NOW + g.int(5) * 1000, lineage: g.pick([null, 'a', 'b']), modern: g.int(2) === 0, shared: true, legacyShared: g.int(4) === 0, heartbeat: null };
  const ids = [1, 2, 3, 4].sort(() => g.rand() - 0.5);
  const hasHolder = g.int(4) !== 0;
  const generation = hasHolder ? 1 + g.int(4) : g.int(3);
  const holder = hasHolder ? { ...entry(g, ids[0], s), generation } : null;
  const line = ids.slice(1, 1 + g.int(3)).map(n => entry(g, n, s));
  s.lease = { generation, holder, line };
  if (holder && g.int(3) === 0) s.heartbeat = { until: iso(s.now + g.pick([-1, 0, 1, LEASE_MS])) };
  if (g.int(25) === 0) s.lease = g.pick([null, { ...s.lease, generation: -1 }, { ...s.lease, line: [...line, ...line.slice(0, 1)] }, { ...s.lease, holder: holder && { ...holder, generation: generation + 1 } }, { generation: 0, holder: holder && { ...holder, generation: 0 }, line }]);
  const name = g.int(30) === 0 ? 'nap' : g.pick(['request', 'request', 'request', ...LEASE_MOVES]);
  const n = g.pick([ids[0], ids[0], ids[1], 1 + g.int(5)]);
  const own = [s.lease?.holder, ...(s.lease?.line ?? [])].find(each => each?.token === token(n));
  const move = { name, token: token(n), branch: g.int(8) === 0 ? 'other' : 'trunk', pid: g.int(8) === 0 ? 9 : 100 + n, label: 'coordinator',
    lineage: g.int(6) === 0 ? 'x' : own ? own.lineage : s.lineage, generation: (s.lease?.generation ?? 0) + (g.int(6) === 0 ? 1 : 0), guardianPid: g.pick([5, 70 + n, 0]) };
  if (g.int(30) === 0) move.token = 'short';
  if (name === 'batch') Object.assign(move, { batch: g.pick(['batch-a', 'batch-b']), ...(g.int(2) === 0 ? { allowance: 2 } : {}) });
  return { s, move };
}

const CASES = 20_000;
const results = Array.from({ length: CASES }, (_, seed) => {
  const { s, move } = scenario(seed + 1);
  return { seed: seed + 1, s, move, result: run(s, move) };
});
const ok = results.filter(c => !c.result.refused);
const tokensOf = (lease) => [lease.holder, ...lease.line].filter(Boolean).map(each => each.token);
const intact = (lease) => Number.isSafeInteger(lease?.generation) && lease.generation >= 0 && Array.isArray(lease.line)
  && (!lease.holder || lease.holder.generation === lease.generation && lease.generation >= 1)
  && [lease.holder, ...lease.line].filter(Boolean).every(valid) && new Set(tokensOf(lease)).size === tokensOf(lease).length;

test('moves.lease.rows-fire: generated: every guard and outcome row of the lease table fires on some seeded case [C7,#8252]', () => {
  const fired = new Set(results.flatMap(c => (c.result.refused ? [c.result.refused.row] : c.result.via)));
  const rows = [...TABLE.guards.map(row => row.id), ...TABLE.outcomes.map(row => row.id)];
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
  assert.ok(ok.length > CASES / 4, `only ${ok.length} accepted moves`);
});

test('moves.lease.refusal-writes-nothing: generated: a refusal writes nothing and names a lease code, a message and a next step; a corrupt queue refuses every known move [C7,#8252]', () => {
  for (const c of results.filter(each => each.result.refused)) {
    const { refused } = c.result;
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}`);
    assert.ok(['LAND_LEASE_REQUEST', 'LAND_LEASE_CORRUPT', 'LAND_LEASE_LOST'].includes(refused.code), `seed ${c.seed}: ${refused.code}`);
    assert.ok(refused.message && refused.next, `seed ${c.seed}`);
  }
  for (const c of results) {
    if (LEASE_MOVES.includes(c.move.name) && !intact(c.s.lease)) assert.equal(c.result.refused?.code, 'LAND_LEASE_CORRUPT', `seed ${c.seed}`);
    if (!LEASE_MOVES.includes(c.move.name)) assert.equal(c.result.refused?.row, 'known', `seed ${c.seed}`);
  }
});

test('moves.lease.whole-queue: generated: every accepted move leaves a whole queue, the generation rising by at most one and only when the trunk changes hands [C7,#8252]', () => {
  for (const c of ok) {
    const before = c.s.lease, after = c.result.patch.lease;
    assert.ok(intact(after), `seed ${c.seed}: ${JSON.stringify(after)}`);
    const rise = after.generation - before.generation;
    assert.ok(rise === 0 || rise === 1, `seed ${c.seed}: generation ${before.generation} -> ${after.generation}`);
    const handed = Boolean(after.holder) && (!before.holder || before.holder.token !== after.holder.token || lapsed(c.s, before.holder));
    assert.equal(rise === 1, c.move.name === 'request' && handed, `seed ${c.seed}: rise ${rise}, handed ${handed}`);
  }
});

test('moves.lease.live-holder-only: generated: only the live holder renews, binds or asserts, and those moves keep the holder, the generation and the line [C7,#8252]', () => {
  for (const c of ok.filter(each => HOLDER_MOVES.includes(each.move.name))) {
    const { holder } = c.s.lease;
    const timed = holder.lineage === null || Boolean(c.s.heartbeat) || c.s.legacyShared;
    assert.ok(holder.token === c.move.token && holder.generation === c.move.generation && holder.branch === c.move.branch && holder.lineage === c.s.lineage, `seed ${c.seed}`);
    assert.ok(!timed || Date.parse(c.s.heartbeat?.until ?? holder.until) > c.s.now, `seed ${c.seed}: a lapsed deadline still held`);
    const after = c.result.patch.lease;
    assert.deepEqual([after.generation, after.holder.token, after.line], [c.s.lease.generation, holder.token, c.s.lease.line], `seed ${c.seed}`);
    if (c.move.name === 'assert') assert.deepEqual([after, c.result.events], [c.s.lease, []], `seed ${c.seed}`);
    else assert.equal(after.holder.until, iso(c.s.now + LEASE_MS), `seed ${c.seed}`);
    if (c.move.name === 'bind') assert.equal(after.holder.guardianPid, c.move.guardianPid, `seed ${c.seed}`);
  }
  for (const c of results.filter(each => each.move.name === 'bind' && intact(each.s.lease) && each.s.lease.holder?.token === each.move.token)) {
    const named = c.s.lease.holder.guardianPid;
    const bindable = Number.isSafeInteger(c.move.guardianPid) && c.move.guardianPid >= 1 && !(named && named !== c.move.guardianPid);
    if (c.result.refused?.row === 'lost') continue; // the fence is judged first
    assert.equal(c.result.refused?.row, bindable ? undefined : 'bind', `seed ${c.seed}: guardian ${c.move.guardianPid} over ${named}`);
  }
  for (const c of results.filter(each => HOLDER_MOVES.includes(each.move.name) && intact(each.s.lease) && each.s.lease.holder?.token !== each.move.token)) {
    assert.equal(c.result.refused?.code, 'LAND_LEASE_LOST', `seed ${c.seed}: a non-holder ${c.move.name} was not refused`);
  }
});

test('moves.lease.release-frees: generated: a release takes its token out of the line and frees the holder only at its own generation [C7,#8252]', () => {
  for (const c of ok.filter(each => each.move.name === 'release')) {
    const before = c.s.lease, after = c.result.patch.lease;
    const frees = before.holder?.token === c.move.token && before.holder.generation === c.move.generation;
    assert.deepEqual(after.holder, frees ? null : before.holder, `seed ${c.seed}`);
    assert.deepEqual(after.line, before.line.filter(each => each.token !== c.move.token), `seed ${c.seed}`);
    assert.equal(after.generation, before.generation, `seed ${c.seed}`);
  }
});

test('moves.lease.request-order: generated: a request never steals a live trunk, keeps every live waiter in order, drops the lapsed and names its outcome truly [C7,#8252]', () => {
  for (const c of ok.filter(each => each.move.name === 'request')) {
    const before = c.s.lease, after = c.result.patch.lease, me = c.move.token;
    assert.equal(tokensOf(after).filter(each => each === me).length, 1, `seed ${c.seed}: the caller is in the queue once`);
    const liveHolder = before.holder && !lapsed(c.s, before.holder) ? before.holder : null;
    if (liveHolder) assert.equal(after.holder.token, liveHolder.token, `seed ${c.seed}: a live holder was replaced`);
    const live = [liveHolder, ...before.line.filter(each => !lapsed(c.s, each))].filter(Boolean).map(each => each.token).filter(each => each !== me);
    assert.deepEqual(tokensOf(after).filter(each => each !== me), live, `seed ${c.seed}: live waiters lost, reordered or a lapsed one kept`);
    const via = after.holder.token === me ? (before.holder && lapsed(c.s, before.holder) ? 'reclaim' : 'acquire') : (before.holder && lapsed(c.s, before.holder) ? 'reclaim' : 'queue');
    assert.deepEqual(c.result.via, [via], `seed ${c.seed}`);
    const old = [liveHolder, ...before.line.filter(each => !lapsed(c.s, each))].find(each => each?.token === me);
    if (old) assert.deepEqual([old.branch, old.pid, old.lineage], [c.move.branch, c.move.pid, c.move.lineage ?? null], `seed ${c.seed}: a request changed its identity`);
    const mine = [after.holder, ...after.line].find(each => each.token === me);
    assert.equal(mine.until, iso(c.s.now + LEASE_MS), `seed ${c.seed}`);
  }
});

test('moves.lease.event-per-move: generated: each writing move records one landing_lease event that matches the queue it leaves [C7,#8252]', () => {
  for (const c of ok.filter(each => each.move.name !== 'assert' && each.move.name !== 'inspect')) {
    const after = c.result.patch.lease;
    assert.deepEqual(c.result.events, [{ kind: 'landing_lease', action: c.move.name, token: c.move.token, holder: after.holder?.label ?? null, generation: after.generation, queued: after.line.length }], `seed ${c.seed}`);
  }
});

test('moves.lease.deterministic: generated: the table is deterministic and reads its snapshot without changing it [C7,#8252]', () => {
  for (const c of results.slice(0, 2000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.move);
    assert.deepEqual(runTable(TABLE, RULES, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.move], `seed ${c.seed}`);
  }
});

test('moves.lease.fence-breaks: metamorphic: break any one fence fact of an accepted renew, bind or assert and it is refused LAND_LEASE_LOST [C7,#8252]', () => {
  const held = ok.filter(c => HOLDER_MOVES.includes(c.move.name));
  assert.ok(held.length > 200, `only ${held.length} accepted holder moves`);
  const breaks = {
    token: c => ({ s: c.s, move: { ...c.move, token: token(9) } }),
    generation: c => ({ s: c.s, move: { ...c.move, generation: c.move.generation + 1 } }),
    branch: c => ({ s: c.s, move: { ...c.move, branch: 'elsewhere' } }),
    lineage: c => ({ s: { ...c.s, lineage: `${c.s.lineage}-next` }, move: c.move }),
    deadline: c => ({ s: { ...c.s, now: Date.parse(c.s.heartbeat?.until ?? c.s.lease.holder.until) }, move: c.move }),
  };
  for (const c of held) {
    const timed = c.s.lease.holder.lineage === null || Boolean(c.s.heartbeat) || c.s.legacyShared;
    for (const [name, apply] of Object.entries(breaks)) {
      if (name === 'deadline' && !timed) continue;
      const { s, move } = apply(c);
      assert.equal(run(s, move).refused?.code, 'LAND_LEASE_LOST', `seed ${c.seed}: breaking ${name} still let ${c.move.name} through`);
    }
  }
});

test('moves.lease.repeat-request: metamorphic: change the branch, process or lineage of an accepted repeat request and it is refused LAND_LEASE_REQUEST [C7,#8252]', () => {
  const repeats = ok.filter(c => c.move.name === 'request' && [c.s.lease.holder, ...c.s.lease.line].some(each => each?.token === c.move.token && !lapsed(c.s, each)));
  assert.ok(repeats.length > 100, `only ${repeats.length} accepted repeat requests`);
  for (const c of repeats) {
    for (const change of [{ branch: 'elsewhere' }, { pid: c.move.pid + 1 }, { lineage: `${c.move.lineage}-next` }]) {
      assert.deepEqual(run(c.s, { ...c.move, ...change }).refused?.row, 'identity', `seed ${c.seed}: ${JSON.stringify(change)}`);
    }
  }
});

test('moves.lease.clock-shift: metamorphic: shifting every clock reading by the same amount changes no outcome, only the deadlines it writes [C7,#8252]', () => {
  const shift = (s, by) => {
    const move = (each) => each && { ...each, since: iso(Date.parse(each.since) + by), until: iso(Date.parse(each.until) + by) };
    return { ...s, now: s.now + by, heartbeat: s.heartbeat && { until: iso(Date.parse(s.heartbeat.until) + by) }, lease: { ...s.lease, holder: move(s.lease.holder), line: s.lease.line.map(move) } };
  };
  for (const c of results.filter(each => intact(each.s.lease)).slice(0, 4000)) {
    for (const by of [-3_600_000, 1, 86_400_000]) {
      const moved = run(shift(c.s, by), c.move);
      assert.deepEqual(moved.refused?.row ?? moved.via, c.result.refused?.row ?? c.result.via, `seed ${c.seed}: a ${by} ms shift changed the outcome`);
      if (!c.result.refused) assert.deepEqual(moved.patch.lease, shift({ ...c.s, lease: c.result.patch.lease }, by).lease, `seed ${c.seed}`);
    }
  }
});

test('moves.lease.lapsed-stranger: metamorphic: a lapsed stranger anywhere in the line changes no request, and a request repeated with the same identity changes no place [C7,#8252]', () => {
  for (const c of ok.filter(each => each.move.name === 'request')) {
    const stranger = { token: token(7), branch: 'trunk', pid: 107, label: 'coordinator landing 77777777', lineage: null, since: iso(c.s.now - 9000), until: iso(c.s.now - 1) };
    for (const at of [0, c.s.lease.line.length]) {
      const line = [...c.s.lease.line.slice(0, at), stranger, ...c.s.lease.line.slice(at)];
      const with7 = run({ ...c.s, lease: { ...c.s.lease, line } }, c.move);
      assert.deepEqual([with7.via, with7.patch?.lease], [c.result.via, c.result.patch.lease], `seed ${c.seed}: a lapsed stranger at ${at} changed the request`);
    }
    const mine = [c.result.patch.lease.holder, ...c.result.patch.lease.line].find(each => each.token === c.move.token);
    if (lapsed(c.s, mine)) continue; // an entry bound to another lineage lapses as it is written, so asking again reclaims
    const again = run({ ...c.s, lease: c.result.patch.lease }, c.move);
    assert.deepEqual(tokensOf(again.patch.lease), tokensOf(c.result.patch.lease), `seed ${c.seed}: a repeated request moved places`);
    assert.equal(again.patch.lease.generation, c.result.patch.lease.generation, `seed ${c.seed}`);
  }
});

test('moves.lease.lease-rule: generated: the lease engine refuses LAND_LEASE_RULE for any lease length that is not a positive finite number, or a missing entry check [C7,#8252]', () => {
  for (const leaseMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, '120000']) {
    assert.throws(() => leaseEngine({ leaseMs, valid }), { code: 'LAND_LEASE_RULE' }, String(leaseMs));
  }
  assert.throws(() => leaseEngine({ leaseMs: LEASE_MS, valid: true }), { code: 'LAND_LEASE_RULE' });
  for (const leaseMs of [1, 0.5, LEASE_MS]) assert.equal(typeof leaseEngine({ leaseMs, valid }).table, 'object');
});
