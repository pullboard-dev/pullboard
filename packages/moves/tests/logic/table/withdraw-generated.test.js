/** Tests generated from the withdraw table: every guard and outcome row over thousands of seeded withdrawals, checked against the rule restated here, and metamorphic breaks that must refuse or must not matter [C7,#8264]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { WITHDRAW_NEXT } from '../../../index.js';
import { boardWithdrawEngine } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';
import { withdrawEngine } from '../../../index.js';

const { rules: RULES, table: TABLE } = boardWithdrawEngine();
const ID = 41;
const run = (snapshot, move) => runTable(TABLE, RULES, structuredClone(snapshot), structuredClone(move));
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** The lifecycle states, and the ones a withdrawal may start from, restated from the state machine's withdraw move. */
const STATES = ['open', 'claimed', 'submitted', 'verified', 'merged', 'withdrawn'];
const FROM = ['open', 'claimed', 'submitted', 'verified'];
const CODES = { joined: 'NOT_JOINED', 'coordinator-only': 'COORDINATOR_ONLY', 'note-given': 'NOTE_REQUIRED', 'item-exists': 'NO_ITEM', 'main-red-unchanged': 'STALE_MAIN_RED', 'in-state': 'CLOSED' };
const REASONS = ['fixed on main', '  duplicate of #40  ', 'x', '', '   ', undefined, 5];
const HEX40 = '9a'.repeat(20);

/** A frozen Main red item and the audit that observed it. */
function mainRed(title = 'Main red: packages/a.test.js', check = 'node --test packages/a.test.js', frozenText = JSON.stringify({ title, check })) {
  const digest = sha(frozenText);
  return { item: { id: ID, status: 'open', title, check, frozen: frozenText, frozenDigest: digest }, expected: { status: 'open', title, check, frozenDigest: digest, head: HEX40 } };
}

/** One fact of a Main red audit broken, each labelled with whether the audit still matches; the head must be 40 to 64 lowercase hex characters. */
const AUDIT_BREAKS = {
  none: [true, () => mainRed()], head64: [true, (a) => { a.expected.head = 'f9'.repeat(32); return a; }], extraKey: [true, () => mainRed(undefined, undefined, JSON.stringify({ title: 'Main red: packages/a.test.js', check: 'node --test packages/a.test.js', more: 1 }))],
  head39: [false, (a) => { a.expected.head = HEX40.slice(1); return a; }], head65: [false, (a) => { a.expected.head = `${'f9'.repeat(32)}a`; return a; }],
  headUpper: [false, (a) => { a.expected.head = HEX40.toUpperCase(); return a; }], headNumber: [false, (a) => { a.expected.head = 9; return a; }],
  bothClaimed: [false, (a) => { a.item.status = 'claimed'; a.expected.status = 'claimed'; return a; }], itemStatus: [false, (a) => { a.item.status = 'submitted'; return a; }],
  prefix: [false, () => mainRed('Red main: packages/a.test.js')], itemTitle: [false, (a) => { a.item.title = 'Main red: other'; return a; }],
  frozenTitle: [false, () => { const a = mainRed(undefined, undefined, JSON.stringify({ title: 'Main red: other', check: 'node --test packages/a.test.js' })); return a; }],
  frozenCheck: [false, () => mainRed(undefined, undefined, JSON.stringify({ title: 'Main red: packages/a.test.js', check: 'node --test other.js' }))],
  checkNumber: [false, () => mainRed(undefined, 5)], itemCheck: [false, (a) => { a.item.check = 'node --test other.js'; return a; }],
  digestUpper: [false, (a) => { a.item.frozenDigest = a.expected.frozenDigest = a.expected.frozenDigest.toUpperCase(); return a; }],
  digestShort: [false, (a) => { a.item.frozenDigest = a.expected.frozenDigest = a.expected.frozenDigest.slice(1); return a; }],
  itemDigest: [false, (a) => { a.item.frozenDigest = sha('other'); return a; }], edited: [false, (a) => { a.item.frozen = `${a.item.frozen} `; return a; }],
  notJson: [false, () => mainRed(undefined, undefined, 'not json')], noFrozen: [false, (a) => { a.item.frozen = undefined; a.item.frozenDigest = a.expected.frozenDigest = sha(''); return a; }],
  empty: [false, (a) => ({ item: a.item, expected: {} })],
};

/** One seeded withdrawal, biased so every row fires: joined and unjoined callers, blank reasons, missing items, every state, and plain and audit-bound moves. */
function scenario(seed) {
  const g = seeded(seed);
  const s = { actor: { id: 'coordinator', joined: g.int(12) === 0 ? false : g.pick([true, undefined]) }, item: { id: ID, status: g.pick(STATES), title: 'Fix x', check: null, frozen: null, frozenDigest: null, owner: 'core-1', leaseUntil: '2099-01-01T00:00:00.000Z' } };
  const m = { id: ID, actor: g.int(8) === 0 ? 'core-1' : 'coordinator', reason: g.int(4) ? REASONS[g.int(3)] : g.pick(REASONS) };
  let label = true;
  if (g.int(2) === 0) {
    const [holds, make] = g.int(3) === 0 ? AUDIT_BREAKS.none : g.pick(Object.values(AUDIT_BREAKS));
    const audit = make(mainRed());
    s.item = { ...s.item, ...audit.item };
    m.expected = audit.expected;
    label = holds;
  } else if (g.int(4) === 0) m.expected = null;
  if (g.int(20) === 0) s.item = null;
  return { s, m, label };
}

/** The first guard row that refuses, restated in the order the command throws; null when the withdrawal goes through. */
function firstRefusal(c) {
  const { s, m } = c;
  if (s.actor.joined === false) return 'joined';
  if (m.actor !== 'coordinator') return 'coordinator-only';
  if (typeof m.reason !== 'string' || m.reason.trim() === '') return 'note-given';
  if (!s.item) return 'item-exists';
  if (m.expected !== undefined && m.expected !== null && !c.label) return 'main-red-unchanged';
  return FROM.includes(s.item.status) ? null : 'in-state';
}

/** The cause fact's replay-stable id, restated: the hash of the audit, cut into a version-5, variant-8 uuid. */
const factId = (expected) => sha(JSON.stringify(['main-red-fixed', ID, expected.frozenDigest, expected.head])).replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/u, '$1-$2-5$3-8$4-$5');

/** The accepted withdrawal, restated: the item closes with its trimmed reason and no holder; an audit-bound one also records the cause fact. */
function expected({ m }) {
  const reason = m.reason.trim();
  const fact = { kind: 'fact', by: m.actor, detail: { id: factId(m.expected ?? {}), kind: 'measurement', ref: null, supersedes: null,
    text: `Fixed on main by ${m.expected?.head}; every file named in the frozen check passed in the current-tip audit.` } };
  return { patch: { status: 'withdrawn', withdrawnReason: reason, owner: null, leaseUntil: null }, events: [{ kind: 'withdraw', by: m.actor, detail: { reason } }, ...(m.expected ? [fact] : [])],
    via: m.expected ? ['withdraw', 'main-red-fix'] : ['withdraw'] };
}

const CASES = 6000;
const results = Array.from({ length: CASES }, (_, seed) => { const c = scenario(seed + 1); return { seed: seed + 1, ...c, result: run(c.s, c.m) }; });
const ok = results.filter(c => !c.result.refused);

test('moves.withdraw.rows-fire: generated: every guard, outcome and follow-up row of the withdraw table fires on some seeded case [C7,#8264]', () => {
  const fired = new Set(results.flatMap(c => (c.result.refused ? [c.result.refused.row] : c.result.via)));
  assert.deepEqual([...TABLE.guards, ...TABLE.outcomes, ...TABLE.followups].map(row => row.id).filter(row => !fired.has(row)), []);
  assert.deepEqual(Object.keys(CODES), TABLE.guards.map(row => row.id));
  assert.ok(ok.length > CASES / 5, `only ${ok.length} accepted withdrawals`);
});

test('moves.withdraw.refusal-rows: generated: every withdrawal refuses at the guard the restated rules name, writes nothing, and carries its code, message and WITHDRAW_NEXT step [C7,#8264]', () => {
  const words = { 'note-given': 'say why it is withdrawn', 'item-exists': `no item #${ID}; see: pullboard list`, 'main-red-unchanged': `item #${ID} changed after its Main red audit` };
  for (const c of results) {
    const row = firstRefusal(c), { refused } = c.result;
    assert.equal(refused?.row ?? null, row, `seed ${c.seed}`);
    if (!refused) continue;
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}`);
    assert.deepEqual([refused.code, refused.next], [CODES[row], WITHDRAW_NEXT[CODES[row]]], `seed ${c.seed}`);
    if (row === 'in-state') assert.equal(refused.message, `item #${ID} is ${c.s.item.status}`, `seed ${c.seed}`);
    if (words[row]) assert.equal(refused.message, words[row], `seed ${c.seed}`);
  }
  for (const status of STATES) assert.equal(run({ actor: { id: 'coordinator' }, item: { id: ID, status } }, { id: ID, actor: 'coordinator', reason: 'r' }).refused?.row ?? null, FROM.includes(status) ? null : 'in-state', status);
});

test('moves.withdraw.accepted-writes: generated: each accepted withdrawal writes the patch, events and cause fact the restated rule gives [C7,#8264]', () => {
  for (const c of ok) assert.deepEqual(c.result, expected(c), `seed ${c.seed}`);
  assert.ok(ok.filter(c => c.m.expected).length > 200, 'audit-bound withdrawals accepted');
  for (const c of ok.filter(each => each.m.expected)) assert.match(c.result.events[1].detail.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u, `seed ${c.seed}`);
});

test('moves.withdraw.deterministic: generated: the table is deterministic and reads its snapshot without changing it [C7,#8264]', () => {
  for (const c of results.slice(0, 2000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.m);
    assert.deepEqual(runTable(TABLE, RULES, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.m], `seed ${c.seed}`);
  }
});

test('moves.withdraw.fact-breaks: metamorphic: break one fact of an accepted withdrawal and it refuses with that fact\'s code [C7,#8264]', () => {
  for (const c of ok) {
    const audit = Boolean(c.m.expected);
    const breaks = [
      ['NOT_JOINED', { ...c.s, actor: { ...c.s.actor, joined: false } }, c.m], ['COORDINATOR_ONLY', c.s, { ...c.m, actor: 'core-1' }], ['NOTE_REQUIRED', c.s, { ...c.m, reason: ' \n ' }],
      ['NO_ITEM', { ...c.s, item: null }, c.m], [audit ? 'STALE_MAIN_RED' : 'CLOSED', { ...c.s, item: { ...c.s.item, status: 'merged' } }, c.m],
      ...(audit ? [['STALE_MAIN_RED', { ...c.s, item: { ...c.s.item, title: `${c.s.item.title}!` } }, c.m], ['STALE_MAIN_RED', c.s, { ...c.m, expected: { ...c.m.expected, head: 'HEAD' } }]] : []),
    ];
    for (const [code, s, m] of breaks) assert.equal(run(s, m).refused?.code, code, `seed ${c.seed}: ${code}`);
  }
});

test('moves.withdraw.padding: metamorphic: padding the reason, the caller\'s seat id, the old holder or another audit head changes only what it names [C7,#8264]', () => {
  for (const c of ok) {
    assert.deepEqual(run({ ...c.s, actor: { id: 'seat-9', joined: true }, item: { ...c.s.item, owner: null, leaseUntil: null } }, { ...c.m, reason: ` ${c.m.reason}\n` }), c.result, `seed ${c.seed}`);
    if (!c.m.expected) continue;
    const moved = run(c.s, { ...c.m, expected: { ...c.m.expected, head: 'e'.repeat(40) } });
    assert.deepEqual([moved.patch, moved.events[0], moved.via], [c.result.patch, c.result.events[0], c.result.via], `seed ${c.seed}`);
    assert.notEqual(moved.events[1].detail.id, c.result.events[1].detail.id, `seed ${c.seed}: the fact id ignores the head`);
  }
});

test('moves.withdraw.table-inputs: generated: the withdraw engine refuses WITHDRAW_TABLE_INPUTS without a list of starting states [C7,#8264]', () => {
  for (const board of [undefined, {}, { from: [] }, { from: 'open' }]) assert.throws(() => withdrawEngine(board), { code: 'WITHDRAW_TABLE_INPUTS' }, JSON.stringify(board));
  const narrow = withdrawEngine({ from: ['open'] });
  assert.equal(runTable(narrow.table, narrow.rules, { actor: { id: 'coordinator' }, item: { id: ID, status: 'claimed' } }, { id: ID, actor: 'coordinator', reason: 'r' }).refused?.code, 'CLOSED');
});
