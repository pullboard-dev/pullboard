/** Tests generated from the backbone table: what each job kind serves holds exactly when its words say, over thousands of seeded item and job states, and breaking one fact stops it [C7,#8067,#8328]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKBONE_RULES } from '../../../index.js';
import { BACKBONE_STATES } from '../../../index.js';
import { BACKBONE_TABLE } from '../../../index.js';
import { CREATED_JOB_KINDS } from '../../../index.js';
import { JOB_KINDS } from '../../../index.js';
import { LEGAL_LANDING } from '../../../index.js';
import { landingEngine } from '../../../index.js';
import { landingOf } from '../../../index.js';
import { legalLanding } from '../../../index.js';
import { deriveFact } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';
import { servesRule } from '../../../index.js';

const KINDS = JOB_KINDS.map(job => job.kind);
const serves = (snapshot, kind) => deriveFact(BACKBONE_RULES, servesRule(kind), structuredClone(snapshot)).holds;

/** What each kind needs, in words, written here apart from the rules: one plain test per kind. */
const pinned = (s) => s.item?.commit === s.job?.commit && s.item?.digest === s.job?.digest;
const every = (s, ok) => Array.isArray(s.items) && s.items.length > 0 && s.items.every(ok);
const NEEDS = {
  gate: (s) => s.item?.owner === s.job.seat && s.item.status === 'claimed' && pinned(s),
  'gate-drive': (s) => ['queued', 'running'].includes(s.job.status) && s.item?.status === 'claimed' && pinned(s),
  review: (s) => s.item?.status === 'submitted' && pinned(s) && s.item.reservedBy === s.job.reviewer,
  'landing-run': (s) => every(s, i => i.status === 'verified' && !i.merged),
  landing: (s) => every(s, i => i.status === 'verified' && !i.merged) && every(s, i => i.commit === s.job.commits?.[i.id]),
  'main-test': (s) => s.item === undefined || s.item === null,
  'gate-verdict': (s) => s.item?.status === 'submitted' && pinned(s),
  'flake-diagnose': (s) => s.job.verdict !== undefined,
  'cells-inventory': (s) => s.item === undefined || s.item === null,
  'test-run': (s) => typeof s.job.seat === 'string',
  land: (s) => every(s, i => i.status === 'verified' && !i.merged) && every(s, i => i.acceptedAt === s.job.trunk),
  'gate-shard': (s) => s.item?.status === 'submitted' && pinned(s),
  test: (s) => typeof s.job.seat === 'string',
  'check-baseline': (s) => s.item?.check !== undefined && s.item.check !== null,
  screen: (s) => s.item?.status === 'submitted' && s.item.pace === 'sprint' && s.item.commit === s.job.commit && Boolean(s.base) && s.job.base === s.base,
  'pull-out': (s) => Boolean(s.item) && landingOf(s.item, s.history) === 'pulling',
};

/** A seeded item, item list and job whose fields mostly agree, so every kind is served on some cases and unserved on others. */
function scenario(seed) {
  const g = seeded(seed);
  const kind = g.pick(KINDS);
  const commit = g.pick(['c1', 'c1', 'c2']);
  const items = g.int(5) === 0 ? g.pick([[], undefined]) : Array.from({ length: 1 + g.int(3) }, (_, n) => ({ id: n + 1, status: g.pick(['verified', 'verified', 'verified', 'submitted']), merged: g.int(5) === 0, commit: g.pick(['c1', 'c1', 'c2']), acceptedAt: g.pick(['t1', 't1', 't2']) }));
  const item = g.int(4) === 0 ? g.pick([undefined, null]) : { status: g.pick(['claimed', 'claimed', 'submitted', 'submitted', 'verified']), owner: g.pick(['s1', 's2']), commit: g.pick(['c1', 'c1', 'c2']), digest: g.pick(['d1', 'd1', 'd2']),
    reservedBy: g.pick(['r1', 'r2']), ...(g.int(2) === 0 ? { check: g.pick([null, 'node x']) } : {}) };
  const job = { kind, seat: g.pick(['s1', 's2', 7]), status: g.pick(['queued', 'running', 'done']), reviewer: g.pick(['r1', 'r2']), commit, digest: g.pick(['d1', 'd1', 'd2']), trunk: 't1',
    commits: Object.fromEntries((items ?? []).map(i => [i.id, g.pick(['c1', 'c1', 'c2'])])), ...(g.int(2) === 0 ? { verdict: 'green' } : {}) };
  // Drawn last, so every earlier kind's seeded states stay exactly as they were before the screen and pull-out kinds.
  const base = g.pick(['b1', 'b1', 'b2']);
  if (item) item.pace = g.pick(['sprint', 'sprint', 'steady']);
  job.base = g.pick(['b1', 'b1', 'b2']);
  const history = g.pick([[], [{ kind: 'merged' }], [{ kind: 'merged' }, { kind: 'pull_out' }], [{ kind: 'merged' }, { kind: 'pull_out' }], [{ kind: 'pull_out' }, { kind: 'pulled' }]]);
  return { s: { item, items, job, base, history } };
}

const CASES = 20_000;
const results = Array.from({ length: CASES }, (_, seed) => {
  const { s } = scenario(seed + 1);
  return { seed: seed + 1, s, holds: serves(s, s.job.kind) };
});

test('moves.backbone.kinds-complete: generated: every job kind has one serves rule, in the table, in the kinds list and in the states list, with no kind left out [C7,#8328]', () => {
  assert.equal(new Set(KINDS).size, KINDS.length);
  assert.deepEqual(BACKBONE_TABLE.jobs.map(row => [row.kind, row.serves]), KINDS.map(kind => [kind, servesRule(kind)]));
  for (const kind of KINDS) assert.equal(BACKBONE_RULES[servesRule(kind)].says, JOB_KINDS.find(job => job.kind === kind).serves);
  assert.deepEqual(Object.keys(BACKBONE_RULES).filter(name => name.startsWith('serves.')).sort(), KINDS.map(servesRule).sort());
  assert.deepEqual(Object.keys(NEEDS).sort(), [...KINDS].sort());
  for (const kind of KINDS) assert.ok(BACKBONE_STATES.includes(kind) && BACKBONE_TABLE.states.start.includes(kind), kind);
  assert.equal(new Set(BACKBONE_STATES).size, BACKBONE_STATES.length);
});

test('moves.backbone.served-by-needs: generated: a job is served exactly when its kind needs say it is, for every kind, on seeded states [C7,#8328]', () => {
  for (const kind of KINDS) {
    const mine = results.filter(c => c.s.job.kind === kind);
    assert.ok(mine.some(c => c.holds) && mine.some(c => !c.holds), `${kind}: only ${mine.filter(c => c.holds).length} of ${mine.length} served`);
    for (const c of mine) assert.equal(c.holds, Boolean(NEEDS[kind](c.s)), `seed ${c.seed} (${kind}): ${JSON.stringify(c.s)}`);
  }
});

test('moves.backbone.serves-trace: generated: a serves fact traces only facts it reads, ending on itself, each once [C7,#8328]', () => {
  for (const c of results.slice(0, 3000)) {
    const { trace, fact, holds } = deriveFact(BACKBONE_RULES, servesRule(c.s.job.kind), structuredClone(c.s));
    assert.deepEqual([trace.at(-1).fact, trace.at(-1).holds, fact], [servesRule(c.s.job.kind), holds, servesRule(c.s.job.kind)], `seed ${c.seed}`);
    assert.equal(new Set(trace.map(step => step.fact)).size, trace.length, `seed ${c.seed}`);
  }
});

test('moves.backbone.one-kind-served: metamorphic: a job of one kind is never served as another kind, so at most one serves fact holds per state [C7,#8328]', () => {
  for (const c of results.slice(0, 4000)) {
    const held = KINDS.filter(kind => serves(c.s, kind));
    assert.deepEqual(held, c.holds ? [c.s.job.kind] : [], `seed ${c.seed}`);
  }
});

test('moves.backbone.moved-job-unserved: metamorphic: move the item off the job commit, digest or status, or take away what it serves, and a served job stops being served [C7,#8328]', () => {
  const breaks = {
    gate: [s => ({ ...s, item: { ...s.item, owner: 'z' } }), s => ({ ...s, item: { ...s.item, status: 'submitted' } })],
    'gate-drive': [s => ({ ...s, job: { ...s.job, status: 'done' } }), s => ({ ...s, item: { ...s.item, status: 'verified' } })],
    review: [s => ({ ...s, item: { ...s.item, reservedBy: 'z' } }), s => ({ ...s, item: { ...s.item, status: 'claimed' } })],
    'landing-run': [s => ({ ...s, items: [...s.items, { id: 99, status: 'verified', merged: true }] }), s => ({ ...s, items: [] })],
    landing: [s => ({ ...s, items: s.items.map((i, n) => (n === 0 ? { ...i, commit: 'other' } : i)) }), s => ({ ...s, items: undefined })],
    'main-test': [s => ({ ...s, item: { status: 'claimed' } })],
    'gate-verdict': [s => ({ ...s, item: { ...s.item, status: 'claimed' } })],
    'flake-diagnose': [s => ({ ...s, job: { ...s.job, verdict: undefined } })],
    'cells-inventory': [s => ({ ...s, item: { status: 'claimed' } })],
    'test-run': [s => ({ ...s, job: { ...s.job, seat: undefined } })],
    land: [s => ({ ...s, items: s.items.map((i, n) => (n === 0 ? { ...i, acceptedAt: 'other' } : i)) }), s => ({ ...s, job: { ...s.job, trunk: 'other' } })],
    'gate-shard': [s => ({ ...s, item: { ...s.item, status: 'verified' } })],
    test: [s => ({ ...s, job: { ...s.job, seat: undefined } })],
    'check-baseline': [s => ({ ...s, item: { ...s.item, check: null } }), s => ({ ...s, item: undefined })],
    screen: [s => ({ ...s, item: { ...s.item, pace: 'steady' } }), s => ({ ...s, job: { ...s.job, base: 'other' } }), s => ({ ...s, item: { ...s.item, commit: 'other' } }), s => ({ ...s, item: { ...s.item, status: 'verified' } })],
    'pull-out': [s => ({ ...s, history: [...s.history, { kind: 'pulled' }] }), s => ({ ...s, item: undefined })],
  };
  const pins = [s => ({ ...s, item: { ...s.item, commit: 'other' } }), s => ({ ...s, item: { ...s.item, digest: 'other' } })];
  for (const kind of KINDS) {
    const served = results.filter(c => c.holds && c.s.job.kind === kind);
    assert.ok(served.length > 20, `${kind}: only ${served.length} served`);
    const changes = [...breaks[kind], ...(['gate', 'gate-drive', 'review', 'gate-verdict', 'gate-shard'].includes(kind) ? pins : [])];
    for (const c of served) for (const [n, change] of changes.entries()) assert.equal(serves(change(c.s), kind), false, `seed ${c.seed} (${kind}): break ${n} still served`);
  }
});

test('moves.backbone.read-is-pure: generated: reading a state never changes it and gives the same answer twice [C7,#8328]', () => {
  for (const c of results.slice(0, 2000)) {
    const before = structuredClone(c.s);
    assert.equal(deriveFact(BACKBONE_RULES, servesRule(c.s.job.kind), c.s).holds, c.holds, `seed ${c.seed}`);
    assert.deepEqual(c.s, before, `seed ${c.seed}`);
  }
});

const NOW = '2026-11-15T12:00:00.000Z';
const LATER = '2026-11-15T13:00:00.000Z';
const run = (snapshot, move) => runTable(BACKBONE_TABLE, BACKBONE_RULES, structuredClone(snapshot), structuredClone(move));

/** The few guards the board judges from its own history, each broken by changing that history; every other declared guard is a CLI-side fact, broken by saying it did not hold. */
const BREAKS = {
  itemExists: (s) => ({ ...s, item: { ...s.item, created: false } }),
  inState: (s, m, row) => ({ ...s, item: { ...s.item, status: ['withdrawn', 'open'].find(state => !row.from.includes(state)) } }),
  coordinatorOnly: (s, m) => [s, { ...m, actor: 'w1' }],
  isHolder: (s) => ({ ...s, item: { ...s.item, owner: 'w9' } }),
  holderOrCoordinator: (s, m) => [{ ...s, item: { ...s.item, owner: 'w9' } }, { ...m, actor: 'w1' }],
  releaseOwnsWork: (s, m) => [{ ...s, item: { ...s.item, owner: 'w9' } }, { ...m, actor: 'w1' }],
  notBuilder: (s, m) => ({ ...s, item: { ...s.item, builder: m.actor } }),
  notMerged: (s) => ({ ...s, item: { ...s.item, merged: true } }),
  itemNotHeld: (s) => ({ ...s, item: { ...s.item, held: true } }),
  notHeldByAnother: (s, m) => [{ ...s, item: { ...s.item, status: 'claimed', owner: 'w9', leaseUntil: LATER } }, { ...m, actor: 'w1' }],
  dependenciesVerified: (s) => ({ ...s, item: { ...s.item, after: [7] }, items: new Map([[7, { status: 'claimed' }]]) }),
};
const broken = (guard, snapshot, move, row) => {
  const made = (BREAKS[guard] ?? ((s) => ({ ...s, facts: { [guard]: false } })))(snapshot, move, row);
  return Array.isArray(made) ? made : [made, move];
};

/** A snapshot and move for one declared item move that every guard accepts: the holder is the actor, and a coordinator-only move is the coordinator's. The row that runs is the verb's first row holding the status, as the table reads it. */
function accepted(picked, g) {
  const status = g.pick(picked.from);
  const row = BACKBONE_TABLE.items.find(each => each.verb === picked.verb && each.from.includes(status));
  const who = row.guards.includes('coordinatorOnly') || !row.by.includes('agent') || g.int(2) === 0 ? 'coordinator' : 'w1';
  const item = { status, owner: who, builder: null, merged: false, held: false, after: [], leaseUntil: LATER };
  return { row, snapshot: { item, items: new Map(), facts: {} }, move: { name: row.verb, actor: who, at: NOW, detail: {} } };
}

const GENERATED = 6000;
const rowResults = Array.from({ length: GENERATED }, (_, seed) => {
  const g = seeded(seed + 1);
  const { row, snapshot, move } = accepted(g.pick(BACKBONE_TABLE.items), g);
  const wrecked = row.guards.length > 0 && g.int(4) !== 0 ? g.pick(row.guards) : undefined;
  const [s, m] = wrecked === undefined ? [snapshot, move] : broken(wrecked, snapshot, move, row);
  return { seed: seed + 1, row, wrecked, result: run(s, m) };
});
const unknown = run({ item: { status: 'open', owner: null, after: [] }, items: new Map(), facts: {} }, { name: 'nap', actor: 'coordinator', at: NOW });

test('moves.backbone.rows-fire: generated: every guard and outcome row of the backbone table fires on some seeded case [C7,#8558]', () => {
  const fired = new Set([...rowResults.map(c => (c.result.refused ? c.result.refused.row : c.result.via[0])), unknown.refused.row]);
  const rows = [...BACKBONE_TABLE.guards.map(row => row.id), ...BACKBONE_TABLE.outcomes.map(row => row.id)];
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
  assert.equal(unknown.refused.code, 'UNKNOWN_MOVE');
  for (const c of rowResults) assert.equal(c.result.refused?.row, c.wrecked, `seed ${c.seed}: ${c.row.key} broke ${c.wrecked}`);
  assert.ok(rowResults.filter(c => !c.result.refused).length > GENERATED / 10);
});

/** The limits, fault codes and hold prefix the landing cell would hand in, restated here. */
const LANDING = landingEngine({ limits: { redLimit: 3, runnerSourceRetries: 2, staleProbes: 8 }, faultCodes: ['BOARD_BUSY', 'LAND_RUNNER_FAULT'], repeatHold: 'landing-repeat-test:' });
/** The start pairs today's board holds: every status unlanded, and verified or withdrawn work with a merged commit. */
const derivable = (status) => LEGAL_LANDING[status].filter(landing => landing === 'none' || (landing === 'landed' && ['verified', 'withdrawn'].includes(status)));
/** The pair an accepted move leaves: its patched status, landed once a merged commit or a merged event for this item is written. */
const pairAfter = (item, result) => {
  const merged = result.events.some(event => event.kind === 'merged' && (event.item ?? item.id) === item.id);
  const after = { ...item, ...result.patch, ...(merged ? { mergedCommit: 'm1' } : {}) };
  return [after.status, landingOf(after)];
};

test('moves.backbone.legal-landing-pair: clause 3: every outcome of every move table over generated snapshots writes only a legal status and landing pair [M1,M4]', () => {
  const writes = [];
  // Every declared item move, from every legal start pair it can meet.
  for (let seed = 1; seed <= GENERATED; seed++) {
    const g = seeded(seed);
    const { row, snapshot, move } = accepted(g.pick(BACKBONE_TABLE.items), g);
    const landing = g.pick(derivable(snapshot.item.status));
    const item = { ...snapshot.item, id: 1, merged: landing === 'landed', mergedCommit: landing === 'landed' ? 'm0' : null };
    const result = run({ ...snapshot, item }, move);
    if (result.refused) continue;
    writes.push({ from: [item.status, landing], to: pairAfter(item, result), via: `${row.key} ${result.via.join(',')}` });
  }
  // The landing merged table: plain and forced merges of every status at every legal start pair.
  for (const status of Object.keys(LEGAL_LANDING)) for (const landing of derivable(status)) for (const forced of [undefined, 'landed by hand']) {
    const item = { id: 1, status, mergedCommit: landing === 'landed' ? 'm0' : null };
    const result = runTable(LANDING.tables.merged, LANDING.rules, { item }, { actor: 'coordinator', commit: 'm1', ...(forced ? { forced } : {}) });
    if (!result.refused) writes.push({ from: [status, landing], to: pairAfter(item, result), via: `merged ${result.via.join(',')}` });
  }
  assert.ok(writes.length > GENERATED / 10, `only ${writes.length} accepted writes`);
  assert.ok(writes.some(w => w.from[1] === 'landed') && writes.some(w => w.to[1] === 'landed' && w.from[1] === 'none'), 'landed items are met, and some move lands one');
  assert.ok(writes.some(w => w.to[0] === 'withdrawn' && w.to[1] === 'landed'), 'a forced hand landing of unfinished work writes withdrawn with landed');
  const illegal = writes.filter(w => !legalLanding(...w.to));
  assert.deepEqual(illegal.slice(0, 5), [], `${illegal.length} writes left an illegal pair`);
});

test('clause 2: every declared job kind is created by code, pull-out by the lander, so none waits for a runner [M2,R3,#9100]', () => {
  assert.deepEqual(CREATED_JOB_KINDS, KINDS);
  assert.equal(JOB_KINDS.some(job => job.created === false), false);
});
