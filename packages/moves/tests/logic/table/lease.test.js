/** The landing lease table: acquire, queue, renew, release, expire-and-reclaim and corrupt-state rows with LAND_LEASE_LOST and LAND_LEASE_CORRUPT, and a generated sequence over three landers [C7,#8164]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEASE_MOVES } from '../../../index.js';
import { leaseEngine } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';
import { tableCases } from '../../../index.js';

/** Stand-ins for the store's lease rule and entry check, which the wiring passes in. */
const LEASE_MS = 120_000;
const valid = (entry) => /^[a-f0-9-]{36}$/u.test(entry?.token ?? '') && Number.isFinite(Date.parse(entry.until)) && Number.isFinite(Date.parse(entry.since));
const { rules: RULES, table: TABLE } = leaseEngine({ leaseMs: LEASE_MS, valid });
const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const token = (n) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).repeat(12)}`;
const entry = (n, over = {}) => ({ token: token(n), branch: 'trunk', pid: 100 + n, label: `coordinator landing ${token(n).slice(0, 8)}`, lineage: null,
  since: new Date(NOW - 1000).toISOString(), until: new Date(NOW + LEASE_MS).toISOString(), ...over });
const lease = (over = {}) => ({ generation: 1, holder: { ...entry(1), generation: 1 }, line: [], ...over });
const snap = (over = {}) => ({ lease: lease(), now: NOW, lineage: null, modern: false, shared: true, legacyShared: false, heartbeat: null, ...over });
const ask = (n, name, more = {}) => ({ name, token: token(n), branch: 'trunk', pid: 100 + n, label: 'coordinator', lineage: null, generation: 1, ...more });
const run = (snapshot, move) => runTable(TABLE, RULES, snapshot, move);

test('moves.lease.acquire-hands-a-free-trunk-to: acquire hands a free trunk to the first request and bumps the generation; a second request waits in line [C7,#8164]', () => {
  const free = run(snap({ lease: { generation: 0, holder: null, line: [] } }), ask(1, 'request'));
  assert.deepEqual(free.via, ['acquire']);
  assert.deepEqual([free.patch.lease.generation, free.patch.lease.holder.token, free.patch.lease.holder.generation, free.patch.lease.line], [1, token(1), 1, []]);
  assert.equal(free.patch.lease.holder.until, new Date(NOW + LEASE_MS).toISOString());
  assert.deepEqual(free.events, [{ kind: 'landing_lease', action: 'request', token: token(1), holder: `coordinator landing ${token(1).slice(0, 8)}`, generation: 1, queued: 0 }]);
  const waits = run(snap(), ask(2, 'request'));
  assert.deepEqual(waits.via, ['queue']);
  assert.deepEqual([waits.patch.lease.generation, waits.patch.lease.holder.token, waits.patch.lease.line.map(each => each.token)], [1, token(1), [token(2)]]);
  const again = run(snap({ lease: lease({ line: [entry(2)] }) }), ask(2, 'request'));
  assert.deepEqual(again.patch.lease.line.map(each => each.token), [token(2)]);
  const refresh = run(snap(), ask(1, 'request'));
  assert.deepEqual([refresh.via, refresh.patch.lease.generation, refresh.patch.lease.holder.generation], [['acquire'], 1, 1]);
});

test('moves.lease.the-120-s-expiry-a-holder: the 120 s expiry: a holder is live at its deadline minus one and reclaimed from the deadline on, which bumps the generation [C7,#8164]', () => {
  assert.equal(LEASE_MS, 120_000);
  const held = (until) => snap({ lease: lease({ holder: { ...entry(1), generation: 1, until: new Date(until).toISOString() } }) });
  assert.deepEqual(run(held(NOW + 1), ask(2, 'request')).via, ['queue']);
  const reclaim = run(held(NOW), ask(2, 'request'));
  assert.deepEqual(reclaim.via, ['reclaim']);
  assert.deepEqual([reclaim.patch.lease.generation, reclaim.patch.lease.holder.token, reclaim.patch.lease.line], [2, token(2), []]);
  const handed = run(snap({ lease: lease({ holder: { ...entry(1), generation: 1, until: new Date(NOW - 1).toISOString() }, line: [entry(2)] }) }), ask(3, 'request'));
  assert.deepEqual([handed.via, handed.patch.lease.holder.token, handed.patch.lease.line.map(each => each.token)], [['reclaim'], token(2), [token(3)]]);
  const lapsedLine = run(snap({ lease: lease({ line: [entry(2, { until: new Date(NOW).toISOString() })] }) }), ask(3, 'request'));
  assert.deepEqual(lapsedLine.patch.lease.line.map(each => each.token), [token(3)]);
  const short = leaseEngine({ leaseMs: 5, valid });
  assert.equal(runTable(short.table, short.rules, snap({ lease: { generation: 0, holder: null, line: [] } }), ask(1, 'request')).patch.lease.holder.until, new Date(NOW + 5).toISOString());
});

test('moves.lease.a-lineage-bound-holder-lapses-when: a lineage-bound holder lapses when the coordinator lineage changes, whatever its deadline [C7,#8164]', () => {
  const bound = lease({ holder: { ...entry(1, { lineage: 'a' }), generation: 1 } });
  assert.deepEqual(run(snap({ lease: bound, modern: true, lineage: 'a' }), ask(2, 'request', { lineage: 'a' })).via, ['queue']);
  assert.deepEqual(run(snap({ lease: bound, modern: true, lineage: 'b' }), ask(2, 'request', { lineage: 'b' })).via, ['reclaim']);
});

test('moves.lease.renew-extends-only-the-live-holder: renew extends only the live holder, and refuses LAND_LEASE_LOST for a stale fence, another token, a lapsed deadline or a free trunk [C7,#8164]', () => {
  const renewed = run(snap({ now: NOW + 60_000 }), ask(1, 'renew'));
  assert.deepEqual(renewed.via, ['renew']);
  assert.equal(renewed.patch.lease.holder.until, new Date(NOW + 60_000 + LEASE_MS).toISOString());
  assert.equal(renewed.patch.lease.generation, 1);
  for (const [snapshot, move] of [
    [snap(), ask(2, 'renew')], [snap(), ask(1, 'renew', { generation: 2 })], [snap(), ask(1, 'renew', { branch: 'other' })],
    [snap({ now: NOW + LEASE_MS }), ask(1, 'renew')], [snap({ lease: { generation: 1, holder: null, line: [] } }), ask(1, 'renew')], [snap({ lineage: 'b' }), ask(1, 'assert')],
  ]) {
    const answer = run(snapshot, move);
    assert.equal(answer.refused.code, 'LAND_LEASE_LOST', JSON.stringify(move));
    assert.equal(answer.refused.row, 'lost');
    assert.ok(!('patch' in answer));
  }
  assert.ok(!run(snap({ heartbeat: { until: new Date(NOW + 5).toISOString() } }), ask(1, 'assert')).refused);
  assert.equal(run(snap({ heartbeat: { until: new Date(NOW).toISOString() } }), ask(1, 'assert')).refused.code, 'LAND_LEASE_LOST');
  assert.ok(!run(snap({ now: NOW + LEASE_MS, lease: lease({ holder: { ...entry(1, { lineage: 'a' }), generation: 1 } }), lineage: 'a' }), ask(1, 'assert')).refused);
});

test('moves.lease.bind-names-one-guardian-once-release: bind names one guardian once; release frees the holder only at its own generation and always leaves the line [C7,#8164]', () => {
  assert.equal(run(snap(), ask(1, 'bind', { guardianPid: 77 })).patch.lease.holder.guardianPid, 77);
  assert.equal(run(snap({ lease: lease({ holder: { ...entry(1, { guardianPid: 77 }), generation: 1 } }) }), ask(1, 'bind', { guardianPid: 78 })).refused.code, 'LAND_LEASE_REQUEST');
  assert.equal(run(snap(), ask(1, 'bind', { guardianPid: 0 })).refused.code, 'LAND_LEASE_REQUEST');
  assert.equal(run(snap(), ask(2, 'bind', { guardianPid: 5 })).refused.code, 'LAND_LEASE_LOST');
  const queued = snap({ lease: lease({ line: [entry(2)] }) });
  assert.equal(run(queued, ask(1, 'release')).patch.lease.holder, null);
  assert.equal(run(queued, ask(1, 'release', { generation: 9 })).patch.lease.holder.token, token(1));
  assert.deepEqual(run(queued, ask(2, 'release')).patch.lease.line, []);
  assert.deepEqual(run(queued, ask(2, 'release')).events[0].queued, 0);
});

test('moves.lease.a-request-must-keep-the-identity: a request must keep the identity it first asked with, and carry a valid entry [C7,#8164]', () => {
  for (const change of [{ branch: 'other' }, { pid: 9 }, { lineage: 'x' }]) assert.equal(run(snap(), ask(1, 'request', change)).refused.code, 'LAND_LEASE_REQUEST');
  assert.equal(run(snap(), ask(1, 'request', { token: 'short' })).refused.row, 'entry');
  assert.equal(run(snap(), ask(1, 'nap')).refused.code, 'LAND_LEASE_REQUEST');
  assert.equal(run(snap(), ask(1, 'nap')).refused.row, 'known');
  assert.throws(() => leaseEngine({ leaseMs: 120_000 }), { code: 'LAND_LEASE_RULE' });
});

test('moves.lease.corrupt-state-a-queue-that-is: corrupt-state: a queue that is not whole is LAND_LEASE_CORRUPT for every move and writes nothing [C7,#8164]', () => {
  const broken = [
    null, { generation: -1, holder: null, line: [] }, { generation: 1.5, holder: null, line: [] }, { generation: 1, holder: null, line: 'x' },
    lease({ holder: { ...entry(1), generation: 2 } }), lease({ holder: { ...entry(1), generation: 0 }, generation: 0 }),
    lease({ line: [entry(1)] }), lease({ line: [entry(2), entry(2)] }), lease({ line: [{ ...entry(2), token: 'short' }] }), lease({ holder: { ...entry(1, { until: 'never' }), generation: 1 } }),
  ];
  for (const state of broken) {
    for (const name of LEASE_MOVES) {
      const answer = run(snap({ lease: state }), ask(1, name));
      assert.deepEqual([answer.refused?.code, answer.refused?.row, 'patch' in answer], ['LAND_LEASE_CORRUPT', 'corrupt', false], `${JSON.stringify(state)} ${name}`);
    }
  }
  assert.ok(!run(snap({ lease: { generation: 0, holder: null, line: [] } }), ask(1, 'inspect')).refused);
});

/** A case per row: a free trunk, a live holder, a lapsed holder, the holder's own moves and each way to break a guard. */
function generate(g) {
  const n = 1 + g.int(3);
  const name = g.pick(['request', 'request', 'renew', 'bind', 'release', 'assert']);
  const state = g.pick(['free', 'live', 'lapsed']);
  const holder = { ...entry(1), generation: 1, until: new Date(NOW + (state === 'lapsed' ? -1 : LEASE_MS)).toISOString() };
  const base = state === 'free' ? { generation: 0, holder: null, line: [] } : lease({ holder, line: g.int(2) ? [entry(2)] : [] });
  const mover = name === 'request' ? n : 1;
  const move = ask(mover, name, { guardianPid: 5 });
  const snapshot = snap({ lease: base });
  const breaks = { intact: (s, m) => ({ snapshot: { ...s, lease: { ...s.lease, generation: -1 } }, move: m }) };
  if (name !== 'request') breaks.holder = (s, m) => ({ snapshot: s, move: { ...m, token: token(3) } });
  if (name === 'bind') breaks.bindable = (s, m) => ({ snapshot: s, move: { ...m, guardianPid: 0 } });
  if (name === 'request') breaks.entryValid = (s, m) => ({ snapshot: s, move: { ...m, token: 'x' } });
  return { snapshot, move, breaks };
}

test('moves.lease.generated-cases-reach-every-lease-row: generated cases reach every lease row, never write while refusing, and fail each guard when its fact is broken [C7,#8164]', () => {
  const report = tableCases(TABLE, RULES, generate, { seed: 8164, count: 800 });
  assert.deepEqual(report.writingRefusals, []);
  assert.deepEqual(report.unbroken, []);
  assert.deepEqual(report.unreached.outcomes, []);
});

/** Three landers ask, renew, release and die in a seeded order while the clock jumps; the queue must stay whole. */
function simulate(seed) {
  const g = seeded(seed);
  let state = snap({ lease: { generation: 0, holder: null, line: [] } });
  const held = new Map();
  const accepted = [];
  for (let tick = 0; tick < 60; tick++) {
    const n = 1 + g.int(3);
    const roll = g.int(10);
    if (roll < 2) { state = { ...state, now: state.now + g.pick([1000, LEASE_MS, LEASE_MS * 2]) }; continue; }
    const name = roll < 6 ? 'request' : roll < 8 ? 'renew' : 'release';
    const move = ask(n, name, { generation: held.get(n) ?? 0 });
    const answer = run(state, move);
    if (answer.refused) { assert.ok(['LAND_LEASE_LOST'].includes(answer.refused.code), answer.refused.code); continue; }
    const before = state.lease;
    state = { ...state, lease: answer.patch.lease };
    accepted.push({ move, before, after: state.lease, via: answer.via });
    if (name === 'request' && state.lease.holder?.token === token(n)) held.set(n, state.lease.holder.generation);
  }
  return accepted;
}

test('moves.lease.generated-sequences-over-three-landers-keep: generated sequences over three landers keep one holder, a rising generation and no token twice [C7,#8164]', () => {
  let reclaimed = 0, acquired = 0, queued = 0;
  for (let seed = 1; seed <= 300; seed++) {
    for (const { before, after, via } of simulate(seed)) {
      assert.ok(after.generation >= before.generation && after.generation <= before.generation + 1, 'the generation rises by at most one');
      const tokens = [after.holder, ...after.line].filter(Boolean).map(each => each.token);
      assert.equal(new Set(tokens).size, tokens.length, 'DOUBLE: a token twice in the queue');
      if (after.holder) assert.equal(after.holder.generation, after.generation);
      if (after.generation > before.generation) assert.ok(after.holder, 'a bump hands the trunk to someone');
      if (via[0] === 'reclaim') reclaimed++;
      if (via[0] === 'acquire') acquired++;
      if (via[0] === 'queue') queued++;
    }
  }
  assert.ok(reclaimed > 0 && acquired > 0 && queued > 0, `the generator reaches reclaim, acquire and queue (${reclaimed}, ${acquired}, ${queued})`);
});
