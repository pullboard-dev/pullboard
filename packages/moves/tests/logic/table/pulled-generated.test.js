/** Tests generated from the landing-pulled table: every guard and outcome row over thousands of seeded pull-out reverts, checked against the rule restated here, with one owning test per row [C7,M2,R3,#9187]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PULLED_RULES } from '../../../index.js';
import { PULLED_TABLE } from '../../../index.js';
import { landingOf } from '../../../index.js';
import { pulledEngine } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';

const ID = 42;
const [MERGED, REVERT, LONG] = ['e'.repeat(40), 'b'.repeat(40), 'a'.repeat(64)];
const run = (snapshot, move) => runTable(PULLED_TABLE, PULLED_RULES, structuredClone(snapshot), structuredClone(move));

/** The histories a seeded item may carry, by the landing they leave it at when it has a merged commit. */
const HISTORIES = {
  pulling: [[{ kind: 'merged' }, { kind: 'pull_out' }], [{ kind: 'pull_out' }], [{ kind: 'pulled' }, { kind: 'merged' }, { kind: 'pull_out' }, { kind: 'reopen' }]],
  landed: [[], [{ kind: 'merged' }], [{ kind: 'reopen' }]],
  none: [[{ kind: 'pull_out' }, { kind: 'pulled' }]],
  published: [[{ kind: 'published' }]],
};
const ACTORS = ['coordinator', 'coordinator', 'coordinator', 'core-1', 'lander', ''];
const REVERTS = [REVERT, REVERT, LONG, 'b'.repeat(39), 'B'.repeat(40), '', undefined, null, 'not-a-sha', 5];

/** The rules in words, written here apart from the table: which refusal a pulled record earns, in the table's order, or null when it is accepted. */
function verdict(s, m) {
  if (m.actor !== 'coordinator') return 'COORDINATOR_ONLY';
  if (!s.item) return 'NO_ITEM';
  if (landingOf(s.item, s.history) !== 'pulling') return 'NOT_PULLING';
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(String(m.revert ?? ''))) return 'REVERT_COMMIT';
  return null;
}

/** One seeded pulled record: an item at some landing (or no item), a seat and a revert commit of any shape. */
function scenario(seed) {
  const g = seeded(seed);
  const landing = g.pick(['pulling', 'pulling', 'pulling', 'landed', 'none', 'published']);
  const merged = g.pick([MERGED, MERGED, null]);
  const item = g.int(12) === 0 ? null : { id: ID, status: g.pick(['open', 'claimed', 'submitted']), mergedCommit: merged };
  const s = { item, history: structuredClone(g.pick(HISTORIES[landing])) };
  const m = { id: ID, actor: g.pick(ACTORS), revert: g.pick(REVERTS) };
  return { seed, s, m };
}

const CASES = 5_000;
const results = Array.from({ length: CASES }, (_, seed) => {
  const c = scenario(seed + 1);
  return { ...c, expected: verdict(c.s, c.m), result: run(c.s, c.m) };
});
const accepted = results.filter((c) => !c.result.refused);
const refusedAt = (row) => results.filter((c) => c.result.refused?.row === row);

/** An accepted pulled record to break one fact of: a merged item mid pull-out, named by the coordinator with a full revert. */
const BASE = { s: { item: { id: ID, status: 'open', mergedCommit: MERGED }, history: [{ kind: 'merged' }, { kind: 'pull_out' }] }, m: { id: ID, actor: 'coordinator', revert: REVERT } };
const broken = (change) => { const c = structuredClone(BASE); change(c); return run(c.s, c.m); };

test('moves.pulled.rows-fire: clause 1: generated: every guard and outcome row of the pulled table fires on some seeded case, and each case is refused with the code the rules in words name or accepted when they name none [C7,#9187]', () => {
  const fired = new Set(results.map((c) => (c.result.refused ? c.result.refused.row : c.result.via[0])));
  const rows = [...PULLED_TABLE.guards.map((row) => row.id), ...PULLED_TABLE.outcomes.map((row) => row.id)];
  assert.deepEqual(rows, ['coordinator', 'item-exists', 'pulling', 'revert-named', 'pulled']);
  assert.deepEqual(rows.filter((row) => !fired.has(row)), []);
  for (const c of results) assert.equal(c.result.refused?.code ?? null, c.expected, `seed ${c.seed}: ${JSON.stringify([c.s, c.m])}`);
  for (const c of results.filter((each) => each.result.refused)) {
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}: a refusal writes nothing`);
    assert.ok(c.result.refused.message && c.result.refused.next, `seed ${c.seed}: a refusal names a message and a next step`);
  }
  assert.deepEqual(pulledEngine(), { table: PULLED_TABLE, rules: PULLED_RULES });
  for (const c of results.slice(0, 1000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.m);
    assert.deepEqual(runTable(PULLED_TABLE, PULLED_RULES, snapshot, move), c.result, `seed ${c.seed}: deterministic`);
    assert.deepEqual([snapshot, move], [c.s, c.m], `seed ${c.seed}: reads without changing`);
  }
});

test('moves.pulled.coordinator: clause 1: generated: a pulled record by any seat but the coordinator is refused COORDINATOR_ONLY before anything else is read [C7,#9187]', () => {
  const cases = refusedAt('coordinator');
  assert.ok(cases.length > 200, `only ${cases.length} cases`);
  for (const c of cases) assert.deepEqual([c.m.actor !== 'coordinator', c.result.refused.code], [true, 'COORDINATOR_ONLY'], `seed ${c.seed}`);
  for (const actor of ['core-1', 'lander', '', undefined]) assert.equal(broken((c) => { c.m.actor = actor; c.s.item = null; }).refused?.code, 'COORDINATOR_ONLY', String(actor));
});

test('moves.pulled.item-exists: clause 1: generated: a pulled record for no item is refused NO_ITEM, naming the id and the list command [C7,#9187]', () => {
  const cases = refusedAt('item-exists');
  assert.ok(cases.length > 20, `only ${cases.length} cases`);
  for (const c of cases) assert.deepEqual([c.s.item, c.result.refused.code, c.result.refused.next], [null, 'NO_ITEM', 'pullboard list'], `seed ${c.seed}`);
  assert.match(broken((c) => { c.s.item = null; }).refused.message, /no item #42/u);
});

test('moves.pulled.pulling: clause 1: generated: a pulled record for an item whose landing is not pulling is refused NOT_PULLING, whatever its status [C7,#9187]', () => {
  const cases = refusedAt('pulling');
  assert.ok(cases.length > 200, `only ${cases.length} cases`);
  for (const c of cases) assert.deepEqual([landingOf(c.s.item, c.s.history) === 'pulling', c.result.refused.code], [false, 'NOT_PULLING'], `seed ${c.seed}`);
  for (const history of [[], [{ kind: 'merged' }], [{ kind: 'pull_out' }, { kind: 'pulled' }], [{ kind: 'published' }]]) {
    assert.equal(broken((c) => { c.s.history = history; }).refused?.code, 'NOT_PULLING', JSON.stringify(history));
  }
});

test('moves.pulled.revert-named: clause 1: generated: a pulled record whose revert is not a full lowercase commit is refused REVERT_COMMIT [C7,#9187]', () => {
  const cases = refusedAt('revert-named');
  assert.ok(cases.length > 200, `only ${cases.length} cases`);
  for (const c of cases) assert.deepEqual([c.m.revert === REVERT || c.m.revert === LONG, c.result.refused.code], [false, 'REVERT_COMMIT'], `seed ${c.seed}`);
  for (const revert of ['b'.repeat(39), 'b'.repeat(41), 'B'.repeat(40), 'g'.repeat(40), '', null, undefined]) {
    assert.equal(broken((c) => { c.m.revert = revert; }).refused?.code, 'REVERT_COMMIT', String(revert));
  }
});

test('moves.pulled.pulled: clause 1: generated: an accepted pulled record changes no item field and writes one pulled event by the coordinator naming the revert and the reverted merge, which ends the pull-out [C7,#9187]', () => {
  assert.ok(accepted.length > 200, `only ${accepted.length} accepted cases`);
  for (const c of accepted) {
    const reverted = c.s.item.mergedCommit ? { reverted: c.s.item.mergedCommit } : {};
    assert.deepEqual(c.result.via, ['pulled'], `seed ${c.seed}`);
    assert.deepEqual(c.result.patch, {}, `seed ${c.seed}`);
    assert.deepEqual(c.result.events, [{ kind: 'pulled', by: 'coordinator', detail: { commit: c.m.revert, ...reverted } }], `seed ${c.seed}`);
    assert.equal(landingOf(c.s.item, [...c.s.history, ...c.result.events]), 'none', `seed ${c.seed}`);
  }
  assert.ok(accepted.some((c) => !c.s.item.mergedCommit) && accepted.some((c) => c.s.item.mergedCommit), 'accepted cases with and without a merged commit');
});
