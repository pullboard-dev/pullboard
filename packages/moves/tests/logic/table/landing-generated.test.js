/** Tests generated from the five landing tables (select, admit, record, merged, outcome): every guard and outcome row over thousands of seeded cases, checked against the rules restated here, and metamorphic breaks that must refuse or must not matter [C7,#8561]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANDING_NEXT } from '../../../index.js';
import { landingEngine } from '../../../index.js';
import { PACES } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';

/** The limits, fault codes and hold prefix the landing cell would hand in, written here so the tests restate rather than import them. */
const INPUTS = { limits: { redLimit: 3, runnerSourceRetries: 2, staleProbes: 8 }, faultCodes: ['BOARD_BUSY', 'LAND_RUNNER_FAULT'], repeatHold: 'landing-repeat-test:' };
const { rules: RULES, tables: TABLES } = landingEngine(INPUTS);
const NOW = '2026-11-15T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const MIN = 60_000;
const ago = (ms) => new Date(NOW_MS - ms).toISOString();
const ahead = (ms) => new Date(NOW_MS + ms).toISOString();
const ID = 60;
const run = (table, snapshot, move) => runTable(TABLES[table], RULES, structuredClone(snapshot), structuredClone(move));
const entry = (id, commit = 'c1', extra = {}) => ({ id, commit, ...extra });

// ---------------------------------------------------------------------------------------------------------------
// Select: a verified item ready to join a batch, and each fact that keeps it out.
// ---------------------------------------------------------------------------------------------------------------

/** A verified, unmerged, unheld item at its reviewed commit with nothing in its way; `g` varies what is already true and harmless. */
function selectCase(g) {
  const item = { id: ID, status: 'verified', mergedCommit: null, holdReason: null, commit: 'c1', checked: g.pick(['c1', 'c1', 'c2']), after: [] };
  const items = { [ID]: item };
  const batches = g.pick([[], [{ id: 'b1', state: 'landed', base: 'b0', items: [entry(ID)] }], [{ id: 'b1', state: 'blocked', base: 'b0', items: [entry(ID, 'c0')], failures: [{ file: 'x.test.js' }] }]]);
  const s = { now: NOW, base: 'b1', item, items, batches, waivers: [], unverified: [], picked: { count: 0, touched: {} }, collisionFree: g.pick([false, true]), io: {} };
  if (g.int(3) === 0) { items[61] = { id: 61, ...g.pick([{ status: 'withdrawn' }, { status: 'verified', mergedCommit: 'm1' }, { status: 'withdrawn', mergedCommit: 'm1' }]) }; item.after = [61]; }
  if (g.int(4) === 0) Object.assign(s.io, { ownCommits: ['c7'], changedFiles: ['a.js'], redFiles: ['b.js'] }), s.unverified = [{ id: ID, commit: 'c1' }, { id: 62, commit: 'c8' }];
  if (g.int(5) === 0) {
    s.batches = [{ id: 'b2', state: 'blocked', base: 'b1', items: [entry(ID, 'c1', { reviewedCommit: item.checked })], culprits: [entry(ID, 'c1', { reviewedCommit: item.checked, tests: [{ file: 'a.test.js', name: 't' }] })] }];
    s.waivers = [{ test: 'a.test.js', until: ahead(60 * MIN) }];
  }
  // A sprint item lands submitted work, or work verified before it landed [#8863].
  if (g.int(6) === 0) Object.assign(item, { pace: 'sprint', status: g.pick(['submitted', 'verified']) }), s.pace = 'sprint', sprintReady(s);
  return { s, m: { name: 'select', id: ID }, outcome: 'ready' };
}

/** A sprint item's bar unchanged since claim, and a green, trusted screen at its commit on this base that re-checked secrets and hook rules [#8865]. */
const SCREEN = { kind: 'screen', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b1', checks: { secrets: 'green', hooks: 'green' } };
function sprintReady(s) {
  Object.assign(s.item, { digest: 'd1', claimDigest: 'd1' });
  s.io.screen = structuredClone(SCREEN);
}
/** Spoil a case into a submitted sprint item that is otherwise ready, then apply `spoil`. */
const sprint = (spoil) => (c) => { c.s.pace = 'sprint'; Object.assign(c.s.item, { pace: 'sprint', status: 'submitted' }); sprintReady(c.s); spoil(c); };

const SELECT_BREAKS = [
  ['already landed', c => { delete c.s.pace; c.s.item.mergedCommit = 'm9'; }, 'pending', 'NOT_PENDING'],
  ['not verified', c => { delete c.s.pace; c.s.item.status = 'submitted'; }, 'pending', 'NOT_PENDING'],
  ['sprint: already landed', c => { c.s.pace = 'sprint'; c.s.item.mergedCommit = 'm9'; }, 'pending-submitted', 'NOT_PENDING'],
  ['sprint: not submitted', c => { c.s.pace = 'sprint'; c.s.item.status = 'claimed'; }, 'pending-submitted', 'NOT_PENDING'],
  ['sprint: bar changed since claim', sprint(c => { c.s.item.claimDigest = 'd0'; }), 'a6-bar-frozen', 'CRITERIA_CHANGED'],
  ['sprint: screen from an older base', sprint(c => { c.s.io.screen.base = 'b0'; }), 'screened', 'SCREEN_PENDING'],
  ['sprint: red screen', sprint(c => { c.s.io.screen.green = false; }), 'screened', 'SCREEN_PENDING'],
  ['sprint: no trusted hook re-check', sprint(c => { c.s.io.screen.checks.hooks = 'red'; }), 'a8-irreversible', 'LAND_UNCHECKED'],
  ['strict: no full-suite receipt', c => { c.s.pace = 'strict'; Object.assign(c.s.item, { pace: 'strict', status: 'verified', group: 'g1' }); sprintReady(c.s); c.s.io.strictFullSuite = true; }, 'strict-full-suite', 'LAND_SUITE_PENDING'],
  ['held', c => { c.s.item.holdReason = 'coordinator hold'; }, 'not-held', 'ITEM_HELD'],
  ['stale verdict', c => { c.s.io.staleVerdict = { reason: 'main moved' }; }, 'verdict-fresh', 'STALE_VERDICT'],
  ['known red', c => { c.s.batches = [{ id: 'b3', state: 'blocked', base: 'b0', culprits: [entry(ID, 'c1', { reviewedCommit: c.s.item.checked, tests: [{ file: 'a.test.js', name: 't' }] })] }]; c.s.waivers = []; }, 'not-known-red', 'LAND_KNOWN_RED'],
  ['runner source retries used', c => { c.s.batches = [1, 2].map(n => ({ id: `r${n}`, state: 'blocked', base: 'b1', items: [entry(ID)], refusal: { code: 'RUNNER_SOURCE' } })); }, 'runner-source-retries', 'LAND_RUNNER_SOURCE_HELD'],
  ['red in a row', c => { c.s.batches = [1, 2, 3].map(n => ({ id: `d${n}`, state: 'blocked', base: `x${n}`, items: [entry(ID)], failures: [{ file: 'a.test.js' }] })); }, 'not-repeated-red', 'LAND_REPEATED_RED'],
  ['dependency unlanded', c => { c.s.items[61] = { id: 61, status: 'verified' }; c.s.item.after = [61]; }, 'dependencies-landed', 'WAITS_ON_ITEM'],
  ['dependency missing', c => { c.s.item.after = [99]; }, 'dependencies-landed', 'WAITS_ON_ITEM'],
  ['stacked on another submission', c => { c.s.io.ownCommits = ['c7']; c.s.unverified = [{ id: 62, commit: 'c7' }]; }, 'not-stacked', 'STACKED_UNVERIFIED'],
  ['touches a red publish file', c => { c.s.io.redFiles = ['a.js']; c.s.io.changedFiles = ['a.js']; }, 'not-publish-red', 'PUBLISH_RED_FILE'],
  ['shares a picked file', c => { c.s.collisionFree = true; c.s.io.changedFiles = ['a.js']; c.s.picked.touched = { 'a.js': 9 }; }, 'no-overlap', 'LAND_FILE_OVERLAP'],
];

// ---------------------------------------------------------------------------------------------------------------
// Admit: a trunk with no defect and no unfinished batch, adopting one, or retrying a blocked one.
// ---------------------------------------------------------------------------------------------------------------

/** A landing pass on a known trunk: a fresh selection, an adoption of an interrupted batch, or an automatic retry of one blocked before main moved. */
function admitCase(g) {
  const kind = g.pick(['select', 'adopt', 'adopt-auto', 'adopt-flaky', 'retry']);
  const s = { now: NOW, batches: [{ id: 'b1', state: 'landed', base: 't0' }], defects: g.pick([[], [{ branch: 'other', test: 'a.test.js', itemStatus: null, names: ['t'] }], [{ branch: 'main', test: 'a.test.js', itemStatus: 'verified', names: ['t'] }]]), waivers: [], io: { trunk: { commit: 't1', branch: 'main' } } };
  const m = { name: 'admit' };
  if (kind === 'select' && g.int(2)) s.batches.push({ id: 'b2', state: 'blocked', base: 't1', refusal: { code: 'LAND_DIAGNOSTIC' } });
  if (kind === 'adopt') s.batches.push({ id: 'b2', state: g.pick(['ready', 'pushed', 'running']), base: 't1' }), m.adopt = true;
  if (kind === 'adopt-auto') s.batches.push({ id: 'b2', state: 'ready', base: 't1' }), m.automatic = true;
  if (kind === 'adopt-flaky') s.batches.push({ id: 'b2', state: g.pick(['flaky', 'test-defect']), base: 't1' });
  if (kind === 'retry') s.batches.push({ id: 'b2', state: 'blocked', base: 't0', refusal: { code: g.pick(['LAND_DIAGNOSTIC', 'SLOT_DB_LOCKED', 'RUNNER_FAULTY']) } }), m.automatic = true;
  if (g.int(4) === 0) s.defects = [{ branch: 'main', test: 'a.test.js', itemStatus: 'open', names: ['t'] }], s.waivers = [{ test: 'a.test.js', until: ahead(MIN) }].map(w => ({ ...w, test: 't', kind: 'name' }));
  return { s, m, outcome: ['select', 'adopt-flaky'].includes(kind) ? 'select' : kind === 'retry' ? 'retry' : 'adopt', kind };
}

const ADMIT_BREAKS = [
  ['no trunk', c => { c.s.io.trunk = undefined; }, 'trunk', 'LAND_TRUNK'],
  ['test defect holds the trunk', c => { c.s.defects = [{ branch: 'main', test: 'a.test.js', itemStatus: null, names: ['t'] }]; c.s.waivers = []; c.s.io.defectReleased = undefined; }, 'no-test-defect', 'LAND_TEST_DEFECT'],
  ['defect of an open item', c => { c.s.defects = [{ branch: 'main', test: 'b.test.js', itemStatus: 'open', names: ['t'] }]; c.s.waivers = []; }, 'no-test-defect', 'LAND_TEST_DEFECT'],
  ['unfinished batch built over', c => { c.s.batches = [{ id: 'u1', state: 'ready', base: 't1' }]; c.m = { name: 'admit' }; }, 'adopt-only', 'LAND_ADOPT'],
  ['adopt with nothing to adopt', c => { c.s.batches = [{ id: 'b1', state: 'landed', base: 't0' }]; c.m = { name: 'admit', adopt: true }; }, 'adopt-needs-batch', 'LAND_ADOPT'],
];

// ---------------------------------------------------------------------------------------------------------------
// Record: the coordinator, holding the lease, records a pushed batch whose items still stand.
// ---------------------------------------------------------------------------------------------------------------

/** A pushed (or already landed) batch of one to three items, the live lease holder's write, and items still as gated. */
function recordCase(g) {
  const lineage = g.pick(['L1', null]);
  const entries = Array.from({ length: 1 + g.int(3) }, (_, n) => entry(ID + n, 'c1', { merge: `m${n}`, ...(g.int(3) === 0 ? { reviewedCommit: 'c0' } : {}) }));
  const items = Object.fromEntries(entries.map(e => [e.id, { id: e.id, status: 'verified', commit: 'c1', checked: e.reviewedCommit ?? 'c1', mergedCommit: g.int(4) === 0 ? e.merge : null }]));
  const state = g.pick(['pushed', 'trunk', 'pushed', 'landed']);
  const bare = g.int(5) === 0;
  const s = { now: NOW, lineage, batch: { id: 'b5', tip: 'tip1', state, items: entries }, items };
  const m = { name: 'record', actor: 'coordinator', tip: 'tip1' };
  if (!bare) {
    s.lease = { holder: { token: 'k1', generation: 4, branch: 'main', lineage, until: ahead(MIN) } };
    m.fence = { token: 'k1', generation: 4, branch: 'main' };
  }
  return { s, m, outcome: state === 'landed' ? 'already-landed' : 'land', bare };
}

const FENCE = { token: 'k1', generation: 4, branch: 'main' };
const withFence = (c, change) => { c.s.lease ??= { holder: { token: 'k1', generation: 4, branch: 'main', lineage: c.s.lineage, until: ahead(MIN) } }; c.m.fence = { ...(c.m.fence ?? FENCE), ...change }; };
const RECORD_BREAKS = [
  ['not the coordinator', c => { c.m.actor = 'w1'; }, 'coordinator', 'COORDINATOR_ONLY'],
  ['another token', c => withFence(c, { token: 'k2' }), 'fence', 'LAND_LEASE_LOST'],
  ['another generation', c => withFence(c, { generation: 5 }), 'fence', 'LAND_LEASE_LOST'],
  ['another branch', c => withFence(c, { branch: 'other' }), 'fence', 'LAND_LEASE_LOST'],
  ['write with no fence', c => { withFence(c, {}); c.m.fence = undefined; }, 'fence', 'LAND_LEASE_LOST'],
  ['fence with no holder', c => { c.s.lease = {}; c.m.fence = { ...FENCE }; }, 'fence', 'LAND_LEASE_LOST'],
  ['another lineage', c => { withFence(c, {}); c.s.lineage = 'L9'; c.s.lease.holder.lineage = 'L1'; }, 'fence', 'LAND_LEASE_LOST'],
  ['lease ran out', c => { withFence(c, {}); c.s.lineage = null; c.s.lease.holder.lineage = null; c.s.lease.holder.until = ago(MIN); }, 'fence', 'LAND_LEASE_LOST'],
  ['another tip', c => { c.m.tip = 'tip2'; }, 'batch-tip', 'LAND_BATCH'],
  ['no recorded batch', c => { c.s.batch = undefined; }, 'batch-tip', 'LAND_BATCH'],
  ['not pushed', c => { c.s.batch.state = 'ready'; }, 'published', 'LAND_NOT_PUSHED'],
  ['batch blocked', c => { c.s.batch.state = 'blocked'; }, 'published', 'LAND_NOT_PUSHED'],
  ['item changed after the gate', c => { c.s.items[c.s.batch.items[0].id].commit = 'c9'; c.s.batch.state = 'pushed'; }, 'entries-unchanged', 'LAND_ITEM_MOVED'],
  ['item no longer verified', c => { c.s.items[c.s.batch.items[0].id].status = 'submitted'; c.s.batch.state = 'pushed'; }, 'entries-unchanged', 'LAND_ITEM_MOVED'],
  ['item re-reviewed', c => { c.s.items[c.s.batch.items[0].id].checked = 'c9'; c.s.batch.state = 'pushed'; }, 'entries-unchanged', 'LAND_ITEM_MOVED'],
  ['item has another receipt', c => { c.s.items[c.s.batch.items[0].id].mergedCommit = 'other'; c.s.batch.state = 'pushed'; }, 'entries-unchanged', 'LAND_ITEM_MOVED'],
];

// ---------------------------------------------------------------------------------------------------------------
// Merged: the coordinator records a merge, forced when it names why it went around the gate.
// ---------------------------------------------------------------------------------------------------------------

/** A verified strict item in group g1 with the suite setting on and a green, trusted, leased receipt at its commit and digest on this base [#9326]. */
function strictMerge() {
  const item = { id: ID, status: 'verified', commit: 'c1', digest: 'd1', claimDigest: 'd1', group: 'g1', pace: 'strict' };
  return { item, base: 'b2', pace: 'strict', io: { strictFullSuite: true, suite: { kind: 'suite', suite: 'full', group: 'g1', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b2' } } };
}

/** A merge of a verified item, or a forced one of any item with a reason. */
function mergedCase(g) {
  const forced = g.pick([undefined, undefined, 'hand landed', '  fixed by hand  ']);
  const status = forced === undefined ? 'verified' : g.pick(['open', 'claimed', 'submitted', 'verified', 'withdrawn']);
  // Under sprint an unforced merge records submitted work too [#8863].
  if (forced === undefined && g.int(5) === 0) return { s: { item: { id: ID, status: g.pick(['submitted', 'verified']) }, pace: 'sprint' }, m: { name: 'merged', actor: 'coordinator', commit: 'f'.repeat(40) }, outcome: 'merge' };
  // Under strict with the full-suite setting on and a counting receipt, an unforced merge also publishes [#9326].
  if (forced === undefined && g.int(5) === 0) return { s: strictMerge(), m: { name: 'merged', actor: 'coordinator', commit: 'f'.repeat(40) }, outcome: 'merge-publish' };
  return { s: { item: { id: ID, status } }, m: { name: 'merged', actor: 'coordinator', commit: 'f'.repeat(40), ...(forced === undefined ? {} : { forced }) }, outcome: forced !== undefined && ['open', 'claimed', 'submitted'].includes(status) ? 'forced-unfinished' : 'merge' };
}

const MERGED_BREAKS = [
  ['strict: no full-suite receipt', c => { Object.assign(c, { s: strictMerge() }); c.s.io.suite = null; delete c.m.forced; }, 'strict-full-suite', 'LAND_SUITE_PENDING'],
  ['not the coordinator', c => { c.m.actor = 'w1'; }, 'coordinator', 'COORDINATOR_ONLY'],
  ['forced with a blank reason', c => { c.m.forced = '   '; }, 'forced-reason', 'FORCED_REASON'],
  ['forced with an empty reason', c => { c.m.forced = ''; }, 'forced-reason', 'FORCED_REASON'],
  ['forced with a reason that is no text', c => { c.m.forced = 5; }, 'forced-reason', 'FORCED_REASON'],
  ['unverified, unforced', c => { delete c.m.forced; delete c.s.pace; c.s.item.status = 'claimed'; }, 'verified', 'NOT_VERIFIED'],
  ['withdrawn, unforced', c => { delete c.m.forced; delete c.s.pace; c.s.item.status = 'withdrawn'; }, 'verified', 'NOT_VERIFIED'],
  ['sprint: unsubmitted, unforced', c => { delete c.m.forced; c.s.pace = 'sprint'; c.s.item.status = 'claimed'; }, 'submitted', 'NOT_VERIFIED'],
];

// ---------------------------------------------------------------------------------------------------------------
// Outcome: what a finished batch does next. It has no guards, so every case takes the first outcome its facts name.
// ---------------------------------------------------------------------------------------------------------------

/** A finished batch of one or more items, ending on the refusal, culprit or gate result its kind names. */
function outcomeCase(g) {
  const kind = g.pick(['lease-lost', 'fault', 'runner-source', 'runner-source-held', 'item-refused', 'refused', 'refused-repeat', 'culprit', 'proceed', 'return-culprit', 'bisect']);
  const many = ['refused', 'refused-repeat', 'bisect'].includes(kind) ? g.int(2) === 0 : ['return-culprit', 'item-refused'].includes(kind) ? false : g.int(3) === 0;
  const entries = many ? [entry(ID), entry(ID + 1)] : [entry(ID)];
  const batch = { id: 'b9', state: 'running', base: 'b1', items: entries };
  const items = Object.fromEntries(entries.map(e => [e.id, { id: e.id, holdReason: null, mergedCommit: null }]));
  const s = { now: NOW, batch, batches: [batch], perItem: many ? g.pick([false, true]) : true, items, waivers: [], io: { gate: { isGreen: false } } };
  const m = { name: 'outcome' };
  if (kind === 'lease-lost') m.refusal = { code: 'LAND_LEASE_LOST' };
  if (kind === 'fault') m.refusal = { code: g.pick(INPUTS.faultCodes) };
  if (kind === 'runner-source') m.refusal = { code: 'RUNNER_SOURCE' };
  if (kind === 'runner-source-held') {
    m.refusal = { code: 'RUNNER_SOURCE' };
    if (g.int(2) === 0) items[ID].holdReason = 'coordinator hold';
    else s.batches = [{ id: 'r1', state: 'blocked', base: 'b1', items: [entry(ID)], refusal: { code: 'RUNNER_SOURCE' } }, { id: 'r2', state: 'blocked', base: 'b1', items: [entry(ID)], refusal: { code: 'RUNNER_SOURCE' } }, batch];
  }
  if (kind === 'item-refused') { m.refusal = { code: g.pick(['LAND_HEADER', 'RATCHET_ROSE', 'LAND_STATIC_RED']) }; s.perItem = true; }
  if (kind === 'refused' || kind === 'refused-repeat') {
    m.refusal = { code: g.pick(['LAND_MERGE', 'LAND_DIRTY', 'LAND_HEADER']) };
    if (m.refusal.code === 'LAND_HEADER' && !many) m.refusal.code = 'LAND_MERGE';
    batch.refusal = m.refusal;
  }
  if (kind === 'refused-repeat') s.batches = [{ id: 'b8', state: 'blocked', base: 'b0', items: entries, refusal: m.refusal }, batch];
  if (kind === 'culprit') m.culprit = { id: ID, commit: 'c1' };
  if (kind === 'proceed') s.io.gate = g.pick([{ isGreen: true }, { knownMainProof: true }, { waivedProof: true }]);
  if (kind === 'return-culprit') s.perItem = true;
  if (kind === 'bisect') s.perItem = false;
  const via = { 'runner-source-held': 'runner-source', 'refused-repeat': 'refused' }[kind] ?? kind;
  return { s, m, outcome: via, kind, many };
}

// ---------------------------------------------------------------------------------------------------------------
// The generated cases, spoiled one fact in three.
// ---------------------------------------------------------------------------------------------------------------

const CASES_OF = { select: [selectCase, SELECT_BREAKS], admit: [admitCase, ADMIT_BREAKS], record: [recordCase, RECORD_BREAKS], merged: [mergedCase, MERGED_BREAKS], outcome: [outcomeCase, []] };

function scenario(seed) {
  const g = seeded(seed);
  const table = g.pick(['select', 'select', 'admit', 'record', 'record', 'merged', 'outcome', 'outcome']);
  const [make, breaks] = CASES_OF[table];
  const c = make(g);
  const base = structuredClone({ s: c.s, m: c.m });
  const spoil = breaks.length && g.int(3) !== 0 ? g.pick(breaks) : undefined;
  if (spoil) spoil[1](c);
  return { seed, table, kind: c.kind, outcome: c.outcome, many: c.many, spoil, base, s: c.s, m: c.m };
}

const CASES = 24_000;
const results = Array.from({ length: CASES }, (_, seed) => {
  const c = scenario(seed + 1);
  return { ...c, result: run(c.table, c.s, c.m) };
});
const accepted = results.filter(c => !c.spoil);
const of = (table, outcome) => accepted.filter(c => c.table === table && (outcome === undefined || c.outcome === outcome));

test('moves.landing-generated.moves-landing-rows-fire-generated-every-guard-and-outcome-row: moves.landing.rows-fire: generated: every guard and outcome row of the five landing tables fires on some seeded case [C7,#8561]', () => {
  const fired = new Set(results.map(c => `${c.table}:${c.result.refused ? c.result.refused.row : c.result.via[0]}`));
  const rows = Object.entries(TABLES).flatMap(([name, table]) => [...table.guards, ...table.outcomes].map(row => `${name}:${row.id}`));
  assert.equal(rows.length, 47);
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
});

test('moves.landing-generated.moves-landing-refusal-codes-generated-each-case-is-refused-at: moves.landing.refusal-codes: generated: each case is refused at the row and code its spoiled fact names, or takes the outcome its facts name when nothing is spoiled [C7,#8561]', () => {
  for (const c of results) {
    if (c.spoil) assert.deepEqual([c.result.refused?.row, c.result.refused?.code], [c.spoil[2], c.spoil[3]], `seed ${c.seed}: ${c.table}: ${c.spoil[0]}`);
    else assert.deepEqual([c.result.refused, c.result.via[0]], [undefined, c.outcome], `seed ${c.seed}: ${c.table} ${c.kind ?? ''}`);
  }
});

test('moves.landing-generated.moves-landing-refusal-writes-nothing-generated-a-refusal-writes-nothing-and: moves.landing.refusal-writes-nothing: generated: a refusal writes nothing and names a message and the next step its code has [C7,#8561]', () => {
  for (const c of results.filter(each => each.result.refused)) {
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}`);
    assert.ok(c.result.refused.message && c.result.refused.next, `seed ${c.seed}`);
    assert.equal(c.result.refused.next, c.result.refused.row === 'adopt-needs-batch' ? 'run pullboard land' : LANDING_NEXT[c.result.refused.code], `seed ${c.seed}`);
  }
});

test('moves.landing-generated.moves-landing-select-candidate-generated-a-selected-item-writes-no: moves.landing.select-candidate: generated: a selected item writes no patch and one candidate event naming its commit, its reviewed commit when that differs, and the withdrawn dependencies it drops [C7,#8561]', () => {
  const picked = of('select');
  assert.ok(picked.length > 1000, `only ${picked.length} selections`);
  for (const c of picked) {
    const { item } = c.s, dropped = item.after.filter(id => c.s.items[id].status === 'withdrawn' && !c.s.items[id].mergedCommit);
    assert.deepEqual([c.result.patch, c.result.events], [{}, [{ kind: 'candidate', item: ID, detail: { id: ID, commit: 'c1', ...(item.checked === 'c1' ? {} : { reviewedCommit: item.checked }), ...(dropped.length ? { withdrawnDependencies: dropped } : {}) } }]], `seed ${c.seed}`);
  }
  assert.ok(picked.some(c => c.result.events[0].detail.reviewedCommit) && picked.some(c => c.result.events[0].detail.withdrawnDependencies), 'both optional fields are written on some case');
});

test('moves.landing-generated.moves-landing-admit-moves-generated-an-admitted-pass-adopts-an: moves.landing.admit-moves: generated: an admitted pass adopts an interrupted batch it was asked to adopt or that is flaky, retries a retryable blocked batch automatically, and otherwise starts a fresh selection [C7,#8561]', () => {
  for (const c of of('admit')) {
    const batch = c.s.batches.at(-1);
    const wanted = { select: [{ kind: 'select', detail: {} }], adopt: [{ kind: 'adopt', detail: { batch: batch.id } }], retry: [{ kind: 'adopt', detail: { batch: batch.id, retry: true } }] }[c.outcome];
    assert.deepEqual([c.result.patch, c.result.events], [{}, wanted], `seed ${c.seed}: ${c.kind}`);
  }
  for (const row of ['select', 'adopt', 'retry']) assert.ok(of('admit', row).length > 100, `${row}: only ${of('admit', row).length}`);
});

test('moves.landing-generated.moves-landing-record-merges-generated-a-recorded-push-writes-one: moves.landing.record-merges: generated: a recorded push writes one merged event for each item with no receipt and one main-moved event, and a batch already landed writes nothing [C7,#8561]', () => {
  assert.ok(of('record', 'land').length > 1000 && of('record', 'already-landed').length > 400);
  for (const c of of('record', 'already-landed')) assert.deepEqual([c.result.patch, c.result.events], [{}, []], `seed ${c.seed}`);
  for (const c of of('record', 'land')) {
    const open = c.s.batch.items.filter(each => !c.s.items[each.id].mergedCommit);
    assert.deepEqual(c.result.events, [...open.map(each => ({ kind: 'merged', item: each.id, by: 'coordinator', detail: { commit: each.merge } })),
      { kind: 'main-moved', item: null, by: 'coordinator', detail: { sha: 'tip1', batch: 'b5', items: c.s.batch.items.map(each => each.id) } }], `seed ${c.seed}`);
    assert.deepEqual(c.result.patch, {}, `seed ${c.seed}`);
  }
});

test('moves.landing-generated.moves-landing-merged-forced-generated-a-merge-records-the-commit: moves.landing.merged-forced: generated: a merge records the commit, and a forced merge of unfinished work withdraws the item first and says why it went around the gate [C7,#8561]', () => {
  assert.ok(of('merged', 'forced-unfinished').length > 100 && of('merged', 'merge').length > 300);
  for (const c of of('merged')) {
    const reason = typeof c.m.forced === 'string' ? c.m.forced.trim() : '', commit = 'f'.repeat(40);
    if (c.outcome === 'forced-unfinished') assert.deepEqual([c.result.patch, c.result.events], [{ status: 'withdrawn' }, [{ kind: 'withdraw', by: 'coordinator', detail: { reason: `landed by hand at ${commit.slice(0, 12)}: ${reason}` } },
      { kind: 'merged', by: 'coordinator', detail: { commit, forced: true, reason, from: c.s.item.status } }]], `seed ${c.seed}`);
    else if (c.outcome === 'merge-publish') assert.deepEqual([c.result.patch, c.result.events], [{ mergedCommit: commit }, [{ kind: 'merged', by: 'coordinator', detail: { commit } }, { kind: 'published', by: 'coordinator', detail: { commit } }]], `seed ${c.seed}`);
    else assert.deepEqual([c.result.patch, c.result.events], [{ mergedCommit: commit }, [{ kind: 'merged', by: 'coordinator', detail: { commit, ...(reason ? { forced: true, reason, from: c.s.item.status } : {}) } }]], `seed ${c.seed}`);
  }
});

test('moves.landing-generated.moves-landing-outcome-next-generated-a-finished-batch-blocks-reopens: moves.landing.outcome-next: generated: a finished batch blocks, reopens, parks or goes on as the first fact it meets says, and writes what that outcome says [C7,#8561]', () => {
  const REOPEN = [{ kind: 'reopen', item: ID, by: 'coordinator', detail: { landingFailure: true } }];
  const PATCH = { 'lease-lost': {}, fault: { state: 'blocked' }, 'item-refused': { state: 'blocked' }, refused: { state: 'blocked' }, culprit: { state: 'blocked' }, proceed: { state: 'ready' }, 'return-culprit': { state: 'blocked' }, bisect: { state: 'bisecting' } };
  for (const c of of('outcome')) {
    const { patch, events } = c.result;
    if (c.outcome === 'runner-source') assert.deepEqual([patch, events], [c.kind === 'runner-source' ? {} : { state: 'blocked', blocked: [{ id: ID, code: c.s.items[ID].holdReason ? 'ITEM_HELD' : 'LAND_RUNNER_SOURCE_HELD' }] }, []], `seed ${c.seed}: ${c.kind}`);
    else assert.deepEqual(patch, PATCH[c.outcome], `seed ${c.seed}: ${c.kind}`);
    if (['item-refused', 'return-culprit'].includes(c.outcome)) assert.deepEqual(events, REOPEN, `seed ${c.seed}`);
    else if (c.kind === 'refused-repeat') assert.deepEqual(events.map(e => [e.kind, e.item, e.by]), c.s.batch.items.map(e => ['hold_item', e.id, 'coordinator']), `seed ${c.seed}`);
    else if (c.outcome !== 'runner-source') assert.deepEqual(events, [], `seed ${c.seed}: ${c.kind}`);
  }
  for (const kind of ['lease-lost', 'fault', 'runner-source', 'runner-source-held', 'item-refused', 'refused', 'refused-repeat', 'culprit', 'proceed', 'return-culprit', 'bisect']) assert.ok(of('outcome').filter(c => c.kind === kind).length > 50, kind);
});

test('moves.landing-generated.moves-landing-park-words-generated-a-batch-that-repeats-the: moves.landing.park-words: generated: a batch that repeats the cause of the batch before it parks each of its items with a hold whose reason names the cause, the base and the commit [C7,#8561]', () => {
  for (const c of of('outcome', 'refused').filter(each => each.kind === 'refused-repeat')) {
    for (const [n, event] of c.result.events.entries()) {
      assert.equal(event.detail.reason, `${INPUTS.repeatHold}${JSON.stringify({ kind: 'refusal', key: c.m.refusal.code, base: 'b1', commit: 'c1' })} landing parked #${c.s.batch.items[n].id}`, `seed ${c.seed}`);
    }
  }
  for (const c of of('outcome', 'refused').filter(each => each.kind === 'refused')) assert.deepEqual(c.result.events, [], `seed ${c.seed}: a first red parks nobody`);
});

test('moves.landing-generated.moves-landing-deterministic-generated-the-tables-are-deterministic-and: moves.landing.deterministic: generated: the tables are deterministic and read their snapshot without changing it [C7,#8561]', () => {
  for (const c of results.slice(0, 3000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.m);
    assert.deepEqual(runTable(TABLES[c.table], RULES, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.m], `seed ${c.seed}`);
  }
});

test('moves.landing-generated.moves-landing-spoiled-fact-metamorphic-spoil-any-one-fact-of: moves.landing.spoiled-fact: metamorphic: spoil any one fact of an accepted select, admit, record or merged case and it is refused at the row and code that fact names [C7,#8561]', () => {
  assert.ok(accepted.filter(c => c.table !== 'outcome').length > 4000);
  for (const c of accepted.filter(each => each.table !== 'outcome')) {
    for (const [name, spoil, row, code] of CASES_OF[c.table][1]) {
      const copy = structuredClone(c.base);
      spoil(copy);
      const refused = run(c.table, copy.s, copy.m).refused;
      assert.deepEqual([refused?.row, refused?.code], [row, code], `seed ${c.seed}: ${c.table}: ${name}`);
    }
  }
});

test('moves.landing-generated.moves-landing-always-rows-clause-3-every-landing-select-row-tagged: moves.landing.always-rows: clause 3: every landing-select row tagged always appears in the rows of sprint and strict, and steady holds none of them [M2,#8865]', () => {
  const select = TABLES.select.guards;
  const tagged = select.filter(row => row.always);
  assert.deepEqual(tagged.map(row => [row.id, row.always]), [['a6-bar-frozen', 'A6'], ['a8-irreversible', 'A8']]);
  // Restated: a row with no paces applies under every pace, and a snapshot with no pace runs as steady.
  const rowsOf = (pace) => select.filter(row => !row.paces || row.paces.includes(pace ?? 'steady')).map(row => row.id);
  for (const pace of ['sprint', 'strict']) for (const row of tagged) assert.ok(rowsOf(pace).includes(row.id), `${row.id} is a ${pace} row`);
  assert.deepEqual(rowsOf('steady'), rowsOf(undefined), 'a snapshot with no pace runs as steady');
  assert.deepEqual(rowsOf('steady').filter(id => tagged.some(row => row.id === id) || id === 'screened'), [], 'steady reads no Always or screen row: verify holds its bar and no receipt exists');
});
