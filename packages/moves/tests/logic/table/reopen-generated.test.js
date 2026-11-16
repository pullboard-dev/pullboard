/** Tests generated from the reopen table: every guard and outcome row over thousands of seeded reopens, checked against the rule restated here, and metamorphic breaks that must refuse or must not matter [C7,#8559]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REOPEN_NEXT } from '../../../index.js';
import { boardReopenEngine } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';

const { rules: RULES, table: TABLE } = boardReopenEngine();
const ID = 42;
const run = (snapshot, move) => runTable(TABLE, RULES, structuredClone(snapshot), structuredClone(move));

/** The cause keys the board accepts and refuses, restated: a trimmed `kind:name` key, or none at all. */
const CAUSES = ['refusal:MERGE_CONFLICT', 'refusal:LANDING_RED', undefined, null, 'nonsense', '  refusal:X ', '', 5];
const GOOD_CAUSE = (cause) => cause === undefined || cause === null || cause === 'refusal:MERGE_CONFLICT' || cause === 'refusal:LANDING_RED';
const blank = (text) => !(typeof text === 'string' && text.trim());

/** The rules in words, written here apart from the table: which refusal a reopen earns, in the table's order, or null when it is accepted. */
function verdict(s, m) {
  const merge = m.conflict !== undefined && m.conflict !== null;
  if (s.actor?.joined === false) return 'NOT_JOINED';
  if (!s.item) return 'NO_ITEM';
  if (!['submitted', 'verified'].includes(s.item.status)) return 'NOT_SUBMITTED';
  if (!(m.actor === 'coordinator' || (m.withdrawVerdict === true && Boolean(s.withdrawal)))) return 'COORDINATOR_ONLY';
  if (!(merge || !blank(m.note))) return 'NOTE_REQUIRED';
  if (!GOOD_CAUSE(m.cause)) return 'BAD_CAUSE';
  if (s.item.status === 'verified' && s.item.mergedCommit) return 'ALREADY_MERGED';
  if (!(m.withdrawVerdict === true || s.item.status !== 'verified' || merge || (s.landing?.accepted !== undefined && s.landing?.failure))) return 'LANDING_FAILURE_REQUIRED';
  if (merge && s.conflict?.accepted === false) return 'CONFLICT_FILES';
  return null;
}

/** The outcome row an accepted reopen takes, in the table's order. */
function outcome(s, m) {
  if (m.withdrawVerdict === true) return 'withdraw-verdict';
  if (m.conflict !== undefined && m.conflict !== null) return 'return-conflict';
  if (s.item.status === 'verified' && s.landing?.failure) return 'return-landing-failure';
  return 'return-submission';
}

/** One seeded reopen (the shell always looks up the accept it withdraws, so a coordinator's verdict withdrawal carries one): callers joined or not, items missing, in every state, merged or not; notes blank or given; causes good and bad; conflict, withdrawal and landing facts that mostly let a reopen through. */
function scenario(seed) {
  const g = seeded(seed);
  const s = {
    actor: { id: 'w1', joined: g.int(12) === 0 ? false : g.pick([true, undefined]) },
    item: g.int(15) === 0 ? null : { id: ID, status: g.pick(['open', 'claimed', 'submitted', 'submitted', 'verified', 'verified']), commit: 'c1', mergedCommit: g.pick([null, null, null, 'm1']) },
    landing: g.pick([{}, { accepted: 'e1', failure: 'red' }, { accepted: 'e1' }, { failure: 'red' }, { accepted: 'e1', failure: null }]),
    conflict: { accepted: g.pick([true, true, false, undefined]), supersedes: g.pick([undefined, 'e2']), detail: g.pick([undefined, { conflict: 'a.js' }]), computed: g.pick([undefined, 'c9']) },
    withdrawal: g.int(3) === 0 ? undefined : { acceptEventId: 'e3' },
    cause: g.pick([undefined, { derived: { cause: 'refusal:DERIVED', supersedes: 'dz' }, overrides: true }, { derived: { cause: 'refusal:DERIVED', supersedes: 'dz' }, overrides: false }, { derived: {} }]),
    reservation: g.pick([undefined, { reopenFirstRefusal: { builder: 'w2', until: 't1' } }]),
  };
  const m = { id: ID, actor: g.int(6) === 0 ? 'w1' : 'coordinator', note: g.int(4) === 0 ? g.pick(['', '   ', undefined, 5]) : g.pick(['why', '  because  ']),
    cause: g.int(5) === 0 ? g.pick(CAUSES) : g.pick([undefined, 'refusal:MERGE_CONFLICT']), conflictNote: g.pick([undefined, 'conflict in a.js']),
    withdrawVerdict: g.pick([undefined, false, true]) };
  if (g.int(4) === 0) m.conflict = g.pick([{ files: ['a.js'] }, 'a.js']);
  else if (g.int(5) === 0) m.conflict = g.pick([null, undefined]);
  if (m.withdrawVerdict === true && m.actor === 'coordinator') s.withdrawal ??= { acceptEventId: 'e3' };
  return { s, m };
}

const CASES = 20_000;
const results = Array.from({ length: CASES }, (_, seed) => {
  const { s, m } = scenario(seed + 1);
  return { seed: seed + 1, s, m, result: run(s, m) };
});
const ok = results.filter(c => !c.result.refused);

test('moves.reopen.rows-fire: generated: every guard and outcome row of the reopen table fires on some seeded case [C7,#8559]', () => {
  const fired = new Set(results.flatMap(c => (c.result.refused ? [c.result.refused.row] : c.result.via)));
  // The seeds run steady, so the rows tagged for other paces are left out here; pull-out.test.js fires those [#8870].
  const steady = (row) => !row.paces || row.paces.includes('steady');
  const rows = [...TABLE.guards, ...TABLE.outcomes].filter(steady).map(row => row.id);
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
  assert.ok(ok.length > CASES / 20, `only ${ok.length} accepted reopens`);
});

test('moves.reopen.refusal-codes: generated: each case is refused with the code the rules in words name, or accepted when they name none [C7,#8559]', () => {
  for (const c of results) assert.equal(c.result.refused?.code ?? null, verdict(c.s, c.m), `seed ${c.seed}: ${JSON.stringify([c.s, c.m])}`);
});

test('moves.reopen.refusal-writes-nothing: generated: a refusal writes nothing and names a message and the next step its code has [C7,#8559]', () => {
  for (const c of results.filter(each => each.result.refused)) {
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}`);
    assert.ok(c.result.refused.message && c.result.refused.next, `seed ${c.seed}`);
    assert.equal(c.result.refused.next, REOPEN_NEXT[c.result.refused.code], `seed ${c.seed}`);
  }
});

test('moves.reopen.outcome-rows: generated: an accepted reopen takes the first outcome row its facts name [C7,#8559]', () => {
  for (const c of ok) assert.deepEqual(c.result.via, [outcome(c.s, c.m)], `seed ${c.seed}`);
});

test('moves.reopen.accepted-leaves-open: generated: each accepted reopen hands the item back open with no verdict, owner or lease, and records one reopen event by the caller [C7,#8559]', () => {
  for (const c of ok) {
    assert.deepEqual(c.result.patch, { status: 'open', verdict: null, verifiedBy: null, owner: null, leaseUntil: null, reviewBy: null, reviewUntil: null }, `seed ${c.seed}`);
    assert.equal(c.result.events.length, 1, `seed ${c.seed}`);
    const [event] = c.result.events;
    assert.deepEqual([event.kind, event.by, event.detail.commit, event.detail.judgment], ['reopen', c.m.actor, 'c1', null], `seed ${c.seed}`);
    const note = (typeof c.m.note === 'string' ? c.m.note.trim() : '') || c.m.conflictNote;
    assert.equal(event.detail.note, note, `seed ${c.seed}`);
  }
});

test('moves.reopen.window-on-returns: generated: the first-refusal window is recorded on a conflict, landing-failure or verdict-withdrawal return and on no plain submission return [C7,#8559]', () => {
  for (const c of ok) {
    const { detail } = c.result.events[0], via = c.result.via[0];
    assert.equal('reopenFirstRefusal' in detail, via !== 'return-submission' && c.s.reservation !== undefined, `seed ${c.seed}: ${via}`);
  }
});

test('moves.reopen.cause-order: generated: the derived cause fills every return, and wins over the return\'s own cause fields when the board says it overrides and loses otherwise [C7,#8559]', () => {
  const returns = ok.filter(c => ['withdraw-verdict', 'return-landing-failure'].includes(c.result.via[0]) && c.s.cause?.derived?.supersedes);
  assert.ok(returns.length > 100, `only ${returns.length} returns with a derived cause`);
  for (const c of returns) {
    const { detail } = c.result.events[0], own = c.result.via[0] === 'withdraw-verdict' ? c.s.withdrawal.acceptEventId : c.s.landing.accepted;
    assert.deepEqual([detail.cause, detail.supersedes], ['refusal:DERIVED', c.s.cause.overrides === false ? own : 'dz'], `seed ${c.seed}`);
  }
  for (const c of ok.filter(each => !each.s.cause?.derived?.cause)) assert.equal('cause' in c.result.events[0].detail, false, `seed ${c.seed}`);
});

test('moves.reopen.deterministic: generated: the table is deterministic and reads its snapshot without changing it [C7,#8559]', () => {
  for (const c of results.slice(0, 2000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.m);
    assert.deepEqual(runTable(TABLE, RULES, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.m], `seed ${c.seed}`);
  }
});

test('moves.reopen.in-state: metamorphic: move an accepted reopen\'s item to any other status and it is refused NOT_SUBMITTED, or ALREADY_MERGED when the new status is verified and merged [C7,#8559]', () => {
  assert.ok(ok.length > 500);
  for (const c of ok.slice(0, 3000)) {
    for (const status of ['open', 'claimed', 'withdrawn', 'merged']) assert.equal(run({ ...c.s, item: { ...c.s.item, status } }, c.m).refused?.code, 'NOT_SUBMITTED', `seed ${c.seed}: ${status}`);
    assert.equal(run({ ...c.s, item: { ...c.s.item, status: 'verified', mergedCommit: 'm9' } }, c.m).refused?.code, 'ALREADY_MERGED', `seed ${c.seed}`);
  }
});

test('moves.reopen.authority: metamorphic: another seat\'s reopen is refused COORDINATOR_ONLY unless it withdraws a verdict that has a recorded accept [C7,#8559]', () => {
  for (const c of ok.filter(each => each.m.actor === 'coordinator').slice(0, 3000)) {
    const other = { ...c.m, actor: 'w9', withdrawVerdict: false };
    assert.equal(run(c.s, other).refused?.code, 'COORDINATOR_ONLY', `seed ${c.seed}`);
    assert.equal(run({ ...c.s, withdrawal: undefined }, { ...c.m, actor: 'w9', withdrawVerdict: true }).refused?.code, 'COORDINATOR_ONLY', `seed ${c.seed}: no accept to withdraw`);
    const withdrawn = run({ ...c.s, withdrawal: { acceptEventId: 'e3' } }, { ...c.m, actor: 'w9', withdrawVerdict: true });
    assert.deepEqual(withdrawn.refused?.code ?? withdrawn.via, withdrawn.refused ? verdict({ ...c.s, withdrawal: { acceptEventId: 'e3' } }, { ...c.m, actor: 'w9', withdrawVerdict: true }) : ['withdraw-verdict'], `seed ${c.seed}`);
  }
});

test('moves.reopen.note-and-cause: metamorphic: take the note away from an accepted reopen and it is refused NOTE_REQUIRED unless it reports a conflict; a malformed cause refuses BAD_CAUSE [C7,#8559]', () => {
  for (const c of ok.slice(0, 3000)) {
    const reported = c.m.conflict !== undefined && c.m.conflict !== null;
    for (const note of ['', '  ', undefined]) assert.equal(run(c.s, { ...c.m, note }).refused?.code, reported ? undefined : 'NOTE_REQUIRED', `seed ${c.seed}`);
    for (const cause of ['nonsense', '  refusal:X ', '', 5]) assert.equal(run(c.s, { ...c.m, cause }).refused?.code, 'BAD_CAUSE', `seed ${c.seed}`);
  }
});

test('moves.reopen.landing-failure: metamorphic: a verified item reopens only after a recorded red landing, a reported conflict or a verdict withdrawal, and a recorded failure turns the plain reopen into a landing-failure return [C7,#8559]', () => {
  const plain = ok.filter(c => c.s.item.status === 'verified' && c.m.withdrawVerdict !== true && !c.m.conflict);
  assert.ok(plain.length > 100, `only ${plain.length} plain verified reopens`);
  for (const c of plain) {
    assert.equal(run({ ...c.s, landing: {} }, c.m).refused?.code, 'LANDING_FAILURE_REQUIRED', `seed ${c.seed}`);
    assert.deepEqual(run({ ...c.s, landing: { accepted: 'e1', failure: 'red' } }, c.m).via, ['return-landing-failure'], `seed ${c.seed}`);
    assert.deepEqual(run({ ...c.s, item: { ...c.s.item, status: 'submitted' }, landing: {} }, c.m).via, ['return-submission'], `seed ${c.seed}: a submitted item needs no landing`);
  }
});

test('moves.reopen.conflict-files: metamorphic: a reported conflict git did not confirm is refused CONFLICT_FILES, and unreported conflicts never are [C7,#8559]', () => {
  const reported = ok.filter(c => c.m.conflict);
  assert.ok(reported.length > 100, `only ${reported.length} reported conflicts`);
  for (const c of reported) {
    assert.equal(run({ ...c.s, conflict: { ...c.s.conflict, accepted: false } }, c.m).refused?.code, 'CONFLICT_FILES', `seed ${c.seed}`);
    assert.equal(run({ ...c.s, conflict: { ...c.s.conflict, accepted: undefined } }, c.m).refused, undefined, `seed ${c.seed}`);
  }
  for (const c of ok.filter(each => !each.m.conflict)) assert.equal(run({ ...c.s, conflict: { accepted: false } }, c.m).refused, undefined, `seed ${c.seed}`);
});
