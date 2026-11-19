/** Tests generated from the gate hop table: invariants every row keeps over thousands of seeded states, and metamorphic breaks that must refuse or must not matter [C7,#8068,#8328]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOP_ATTEMPT_CAP } from '../../../index.js';
import { HOP_MOVES } from '../../../index.js';
import { hopEngine } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';

/** Stand-in for the jobs lease rule, which the wiring passes in. */
const LEASE_MS = 120_000;
const leaseLapsed = (leaseUntil, now) => leaseUntil < now;
const { rules: RULES, table: TABLE } = hopEngine({ leaseMs: LEASE_MS, leaseLapsed });
const NOW = 1_000_000;
const OVER = ['done', 'ended'];
const run = (snapshot, move) => runTable(TABLE, RULES, structuredClone(snapshot), structuredClone(move));

/** The rules in words, written here apart from the table: which code a move earns, tried in the table's order. */
function verdict(s, m) {
  const hop = s.hop ?? null;
  const waits = s.item?.status === 'claimed' && (!hop || (s.item.commit === hop.commit && s.item.digest === hop.digest));
  const open = hop !== null && (hop.state === 'queued' || hop.state === 'driven');
  const lapsed = hop?.state === 'driven' && hop.leaseUntil < s.now;
  if (!HOP_MOVES.includes(m.name)) return 'HOP_UNKNOWN_MOVE';
  if (m.name === 'create' && hop !== null) return 'HOP_EXISTS';
  if (m.name === 'create' && !waits) return 'HOP_NOT_WAITING';
  if (m.name !== 'create' && hop === null) return 'HOP_MISSING';
  if (m.name !== 'create' && !open) return 'HOP_OVER';
  if (m.name === 'acquire' && !(hop.state === 'queued' || lapsed)) return 'HOP_HELD';
  if (['step', 'finish'].includes(m.name) && !(hop.state === 'driven' && hop.owner === m.actor && hop.epoch === m.epoch)) return 'HOP_FENCED';
  if (['acquire', 'step', 'finish'].includes(m.name) && !waits) return 'HOP_ITEM_MOVED';
  if (m.name === 'end' && waits) return 'HOP_STILL_WAITS';
  return null;
}

/** A seeded snapshot and move: the hop is absent, queued, driven live or lapsed, done or ended, and the item mostly still waits on it. */
function scenario(seed) {
  const g = seeded(seed);
  const item = { status: g.pick(['claimed', 'claimed', 'claimed', 'submitted', 'verified']), commit: g.pick(['c1', 'c1', 'c2']), digest: g.pick(['d1', 'd1', 'd2']) };
  const state = g.pick(['queued', 'driven', 'driven', 'driven', 'done', 'ended']);
  const hop = g.int(8) === 0 ? null : { state, owner: state === 'driven' ? g.pick(['a', 'b']) : null, epoch: 1 + g.int(4),
    leaseUntil: g.pick([NOW - LEASE_MS, NOW - 1, NOW, NOW + 1, NOW + LEASE_MS]), attempts: g.int(HOP_ATTEMPT_CAP), commit: 'c1', digest: 'd1' };
  const move = { name: g.int(30) === 0 ? 'nap' : g.pick(HOP_MOVES), actor: g.pick(['a', 'b']), epoch: g.pick([1, 2, 3, 4, undefined]) };
  if (hop && move.epoch !== undefined && g.int(2) === 0) move.epoch = hop.epoch;
  if (move.name === 'finish' && g.int(2) === 0) move.result = 'green';
  return { s: { item, hop, now: NOW }, move };
}

const CASES = 20_000;
const results = Array.from({ length: CASES }, (_, seed) => {
  const { s, move } = scenario(seed + 1);
  return { seed: seed + 1, s, move, result: run(s, move) };
});
const ok = results.filter(c => !c.result.refused);

test('moves.hop-generated.moves-hop-rows-fire-generated-every-guard-and-outcome-row: moves.hop.rows-fire: generated: every guard and outcome row of the hop table fires on some seeded case [C7,#8328]', () => {
  const fired = new Set(results.flatMap(c => (c.result.refused ? [c.result.refused.row] : c.result.via)));
  const rows = [...TABLE.guards.map(row => row.id), ...TABLE.outcomes.map(row => row.id)];
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
  assert.ok(ok.length > CASES / 10, `only ${ok.length} accepted moves`);
});

test('moves.hop-generated.moves-hop-refusal-codes-generated-each-case-is-refused-with: moves.hop.refusal-codes: generated: each case is refused with the code the rules in words name, or accepted when they name none [C7,#8328]', () => {
  for (const c of results) assert.equal(c.result.refused?.code ?? null, verdict(c.s, c.move), `seed ${c.seed}: ${JSON.stringify([c.s, c.move])}`);
});

test('moves.hop-generated.moves-hop-refusal-writes-nothing-generated-a-refusal-writes-nothing-and: moves.hop.refusal-writes-nothing: generated: a refusal writes nothing and names a message and a next step [C7,#8328]', () => {
  for (const c of results.filter(each => each.result.refused)) {
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}`);
    assert.ok(c.result.refused.message && c.result.refused.next, `seed ${c.seed}`);
  }
});

test('moves.hop-generated.moves-hop-epoch-rises-generated-the-owner-epoch-rises-by: moves.hop.epoch-rises: generated: the owner epoch rises by exactly one on acquire, cap and end, never otherwise, and never falls [C7,#8328]', () => {
  for (const c of ok.filter(each => each.move.name !== 'create')) {
    const rise = c.result.patch.hop.epoch - c.s.hop.epoch;
    assert.equal(rise, ['acquire', 'end'].includes(c.move.name) ? 1 : 0, `seed ${c.seed}: ${c.move.name} moved the epoch by ${rise}`);
  }
});

test('moves.hop-generated.moves-hop-accepted-leaves-row-generated-each-accepted-move-leaves-the: moves.hop.accepted-leaves-row: generated: each accepted move leaves the state, owner and lease its row names [C7,#8328]', () => {
  for (const c of ok) {
    const { name, actor } = c.move, before = c.s.hop, after = c.result.patch.hop;
    if (name === 'create') assert.deepEqual(after, { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: c.s.item.commit, digest: c.s.item.digest }, `seed ${c.seed}`);
    if (name === 'step') assert.deepEqual([after.state, after.owner, after.leaseUntil, after.attempts], ['driven', actor, NOW + LEASE_MS, before.attempts], `seed ${c.seed}`);
    if (name === 'finish') assert.deepEqual([after.state, after.owner, after.leaseUntil], ['done', null, before.leaseUntil], `seed ${c.seed}`);
    if (name === 'end') assert.deepEqual([after.state, after.owner, after.attempts], ['ended', null, before.attempts], `seed ${c.seed}`);
    if (name === 'acquire') {
      const lapsedHop = before.state === 'driven', last = before.attempts + 1 >= HOP_ATTEMPT_CAP;
      if (lapsedHop && last) assert.deepEqual([after.state, after.owner, after.attempts], ['ended', null, before.attempts + 1], `seed ${c.seed}: the last driver death must end the hop`);
      else assert.deepEqual([after.state, after.owner, after.leaseUntil, after.attempts], ['driven', actor, NOW + LEASE_MS, before.attempts + (lapsedHop ? 1 : 0)], `seed ${c.seed}`);
    }
    if (name !== 'create') assert.deepEqual([after.commit, after.digest], [before.commit, before.digest], `seed ${c.seed}`);
  }
});

test('moves.hop-generated.moves-hop-attempt-cap-generated-attempts-never-pass-the-cap: moves.hop.attempt-cap: generated: attempts never pass the cap and a finish keeps its result [C7,#8328]', () => {
  for (const c of ok.filter(each => each.move.name !== 'create')) {
    assert.ok(c.result.patch.hop.attempts <= HOP_ATTEMPT_CAP, `seed ${c.seed}`);
    if (c.move.name === 'finish') assert.equal(c.result.patch.hop.result, c.move.result ?? null, `seed ${c.seed}`);
  }
});

test('moves.hop-generated.moves-hop-event-per-move-generated-each-accepted-move-records-one: moves.hop.event-per-move: generated: each accepted move records one hop event of its own kind naming the owner and epoch it wrote [C7,#8328]', () => {
  const kinds = { create: 'hop.created', step: 'hop.stepped', finish: 'hop.finished', end: 'hop.ended' };
  for (const c of ok) {
    assert.equal(c.result.events.length, 1, `seed ${c.seed}`);
    const [event] = c.result.events, after = c.result.patch.hop;
    if (c.move.name !== 'acquire') assert.equal(event.kind, kinds[c.move.name], `seed ${c.seed}`);
    else if (after.state === 'ended') assert.deepEqual(event, { kind: 'hop.capped', attempts: after.attempts }, `seed ${c.seed}`);
    else assert.deepEqual([event.kind, event.owner, event.epoch, 'lapsedFrom' in event], ['hop.acquired', c.move.actor, after.epoch, c.s.hop.state === 'driven'], `seed ${c.seed}`);
  }
});

test('moves.hop-generated.moves-hop-deterministic-generated-the-table-is-deterministic-and: moves.hop.deterministic: generated: the table is deterministic and reads its snapshot without changing it [C7,#8328]', () => {
  for (const c of results.slice(0, 2000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.move);
    assert.deepEqual(runTable(TABLE, RULES, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.move], `seed ${c.seed}`);
  }
});

test('moves.hop-generated.moves-hop-fence-breaks-metamorphic-break-any-one-fence-fact: moves.hop.fence-breaks: metamorphic: break any one fence fact of an accepted step or finish and it is refused HOP_FENCED [C7,#8328]', () => {
  const held = ok.filter(c => ['step', 'finish'].includes(c.move.name));
  assert.ok(held.length > 200, `only ${held.length} accepted steps and finishes`);
  const breaks = {
    actor: c => ({ s: c.s, move: { ...c.move, actor: `${c.move.actor}2` } }),
    epochUp: c => ({ s: c.s, move: { ...c.move, epoch: c.move.epoch + 1 } }),
    epochDown: c => ({ s: c.s, move: { ...c.move, epoch: c.move.epoch - 1 } }),
    epochMissing: c => ({ s: c.s, move: { ...c.move, epoch: undefined } }),
    ownerChanged: c => ({ s: { ...c.s, hop: { ...c.s.hop, owner: 'z' } }, move: c.move }),
    epochBumped: c => ({ s: { ...c.s, hop: { ...c.s.hop, epoch: c.s.hop.epoch + 1 } }, move: c.move }),
  };
  for (const c of held) for (const [name, apply] of Object.entries(breaks)) {
    const { s, move } = apply(c);
    assert.equal(run(s, move).refused?.code, 'HOP_FENCED', `seed ${c.seed}: breaking ${name} still let ${c.move.name} through`);
  }
});

test('moves.hop-generated.moves-hop-item-moved-metamorphic-move-the-item-off-an: moves.hop.item-moved: metamorphic: move the item off an accepted acquire, step or finish and it is refused HOP_ITEM_MOVED, and an end then succeeds [C7,#8328]', () => {
  const served = ok.filter(c => ['acquire', 'step', 'finish'].includes(c.move.name));
  assert.ok(served.length > 400, `only ${served.length} accepted moves`);
  for (const c of served) {
    for (const item of [{ ...c.s.item, status: 'submitted' }, { ...c.s.item, commit: 'c9' }, { ...c.s.item, digest: 'd9' }]) {
      const moved = { ...c.s, item };
      assert.equal(run(moved, c.move).refused?.code, 'HOP_ITEM_MOVED', `seed ${c.seed}: ${JSON.stringify(item)}`);
      assert.equal(run(moved, { name: 'end', actor: c.move.actor }).patch?.hop.state, 'ended', `seed ${c.seed}`);
    }
  }
  for (const c of ok.filter(each => each.move.name === 'end')) {
    assert.equal(run({ ...c.s, item: { status: 'claimed', commit: c.s.hop.commit, digest: c.s.hop.digest } }, c.move).refused?.code, 'HOP_STILL_WAITS', `seed ${c.seed}`);
  }
});

test('moves.hop-generated.moves-hop-old-owner-refused-metamorphic-an-acquired-hop-refuses-the: moves.hop.old-owner-refused: metamorphic: an acquired hop refuses the old owner at its old epoch and every second acquire until the lease lapses [C7,#8328]', () => {
  const taken = ok.filter(c => c.move.name === 'acquire' && c.result.patch.hop.state === 'driven');
  assert.ok(taken.length > 200, `only ${taken.length} accepted acquires`);
  for (const c of taken) {
    const now = { ...c.s, hop: c.result.patch.hop };
    const rival = c.move.actor === 'a' ? 'b' : 'a';
    assert.equal(run(now, { name: 'acquire', actor: rival }).refused?.code, 'HOP_HELD', `seed ${c.seed}`);
    assert.equal(run(now, { name: 'acquire', actor: c.move.actor }).refused?.code, 'HOP_HELD', `seed ${c.seed}`);
    for (const stale of ['step', 'finish']) assert.equal(run(now, { name: stale, actor: c.move.actor, epoch: c.s.hop.epoch }).refused?.code, 'HOP_FENCED', `seed ${c.seed}: ${stale} at the old epoch`);
    const later = run({ ...now, now: now.hop.leaseUntil + 1 }, { name: 'acquire', actor: rival });
    assert.ok(later.refused === undefined, `seed ${c.seed}: a lapsed lease could not be acquired`);
    assert.ok(later.patch.hop.epoch === now.hop.epoch + 1, `seed ${c.seed}`);
  }
});

test('moves.hop-generated.moves-hop-settled-hop-metamorphic-a-done-or-ended-hop: moves.hop.settled-hop: metamorphic: a done or ended hop refuses every move but a create, and a create refuses HOP_EXISTS [C7,#8328]', () => {
  for (const c of results.filter(each => each.s.hop && OVER.includes(each.s.hop.state))) {
    const wanted = c.move.name === 'create' ? 'HOP_EXISTS' : HOP_MOVES.includes(c.move.name) ? 'HOP_OVER' : 'HOP_UNKNOWN_MOVE';
    assert.equal(c.result.refused?.code, wanted, `seed ${c.seed}`);
  }
});

test('moves.hop-generated.moves-hop-clock-shift-metamorphic-shifting-every-clock-reading-by: moves.hop.clock-shift: metamorphic: shifting every clock reading by the same amount changes no outcome, only the deadline it writes [C7,#8328]', () => {
  const shift = (s, by) => ({ ...s, now: s.now + by, hop: s.hop && { ...s.hop, leaseUntil: s.hop.leaseUntil + by } });
  for (const c of results.slice(0, 5000)) {
    for (const by of [-3_600_000, 1, 86_400_000]) {
      const moved = run(shift(c.s, by), c.move);
      assert.deepEqual(moved.refused?.row ?? moved.via, c.result.refused?.row ?? c.result.via, `seed ${c.seed}: a ${by} ms shift changed the outcome`);
      if (!c.result.refused && c.result.patch.hop.leaseUntil === NOW + LEASE_MS) assert.equal(moved.patch.hop.leaseUntil, NOW + by + LEASE_MS, `seed ${c.seed}`);
    }
  }
});

test('moves.hop-generated.moves-hop-lease-rule-generated-the-hop-engine-refuses-hop-lease: moves.hop.lease-rule: generated: the hop engine refuses HOP_LEASE for a missing lease length or lapse rule [C7,#8328]', () => {
  for (const lease of [undefined, {}, { leaseMs: Number.NaN, leaseLapsed }, { leaseMs: LEASE_MS }, { leaseMs: LEASE_MS, leaseLapsed: true }]) {
    assert.throws(() => hopEngine(lease), { code: 'HOP_LEASE' }, JSON.stringify(lease));
  }
});
