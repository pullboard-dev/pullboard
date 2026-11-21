/** Tests generated from the claim and renew table: invariants every row keeps over thousands of seeded claims, and metamorphic breaks that must refuse or must not matter [C7,#8264]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAIM_NEXT } from '../../../index.js';
import { boardClaimEngine } from '../../../index.js';
import { claimEngine } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';

const { rules: RULES, table: TABLE } = boardClaimEngine();
const ROUTES = ['light', 'mid', 'strong'];
const NOW = '2026-11-15T12:00:00.000Z';
const at = (ms) => new Date(Date.parse(NOW) + ms).toISOString();
const ID = 40;
const HEX = 'a'.repeat(64);
const key = (c) => `${c.repeat(8)}-0000-4000-8000-${c.repeat(12)}`;
const JOIN = 'pullboard join <lane> --model "<model name>"';
const run = (snapshot, move) => runTable(TABLE, RULES, structuredClone(snapshot), structuredClone(move));
const claim = (id, extra = {}) => ({ id, leaseUntil: at(600_000), parentId: null, verdict: null, builtBy: null, awaitingGateOrReview: false, ...extra });

/** Coordinator corrections in the item's history, each with whether one is still pending (unadopted since the last refreeze). */
const E = (pendingRefreeze) => ['edit', 'coordinator', { pendingRefreeze }];
const CORRECTIONS = [[[], false], [[E(['check'])], true], [[E(['criterion', 'after'])], true], [[E(['title'])], false], [[E(['check']), ['refreeze', 'coordinator', {}]], false],
  [[E(['check']), ['claim', 'w1', { adoptedCorrection: 'd0' }]], false], [[E(['check']), ['renew', 'w1', { adoptedCorrection: 'd0' }]], false], [[E(['check']), ['claim', 'w1', {}]], true],
  [[E(['check']), ['edit', 'coordinator', { correctedFrozen: true }]], false], [[['edit', 'coordinator', { correctedFrozen: true }], E(['check'])], true], [[['refreeze', 'coordinator', {}], E(['after'])], true]];
/** First-refusal histories, each with whether its window still keeps another seat off the item. */
const W = (builder, until = at(3_600_000), extra = {}) => ({ reopenFirstRefusal: { builder, until, ...extra } });
const REOPEN = ['reopen', 'coordinator', W('w4')];
const WINDOWS = [[[], false], [[REOPEN], true], [[REOPEN, ['reject_returned', 'w4', {}], ['submit_handoff_returned', 'w4', {}]], true], [[REOPEN, ['submit', 'w4', {}]], false],
  [[REOPEN, ['reject', 'w3', {}]], false], [[['reopen', 'coordinator', W('w4', at(-1))]], false], [[['reopen', 'coordinator', W('w4', at(0))]], false], [[REOPEN, ['release', 'w4', {}]], false],
  [[REOPEN, ['release', 'w4', { review: true }]], true], [[REOPEN, ['release', 'w6', {}]], true], [[REOPEN, ['release', 'w4', { expiredClaim: true }]], false],
  [[['reopen', 'coordinator', W('w1')]], false], [[['reopen', 'coordinator', W(null)]], false], [[['reopen', 'coordinator', W('w4', 'soon')]], false],
  [[['reject', 'w3', W('w4')]], false], [[['release', 'w4', W('w4', at(3_600_000), { otherSeatFirst: true })]], false],
  [[['reserve', 'w1', {}], ['release', 'w4', W('w4', at(3_600_000), { otherSeatFirst: true })]], true]];

/** One seeded claim the table must accept: fresh, renewed and lapsed items, routes and caps, corrections, policy refreshes, seat caps, windows and every claim beside it that does not count. */
function base(g) {
  const kind = g.pick(['open', 'open', 'renew', 'renew', 'own-lapsed', 'other-lapsed']);
  const renewed = kind === 'renew';
  const actorRoute = g.pick([...ROUTES, undefined]), cap = g.pick([null, null, ...ROUTES]);
  const seat = cap && ROUTES.indexOf(cap) < ROUTES.indexOf(actorRoute ?? 'strong') ? cap : actorRoute ?? 'strong';
  const route = g.pick(ROUTES.slice(0, ROUTES.indexOf(seat) + 1));
  const lane = g.pick(['core', 'view']);
  const [corrections, pending] = g.pick(CORRECTIONS), [windows, blocks] = g.pick(WINDOWS);
  const history = [...(g.int(3) === 0 ? [['claim', g.pick(['w1', 'w2']), {}]] : []), ...corrections, ...windows].map(([kind, by, detail], i) => ({ id: i + 1, kind, by, detail }));
  const item = { status: kind === 'open' ? 'open' : 'claimed', owner: kind === 'open' ? null : kind === 'other-lapsed' ? 'w2' : 'w1', gateInFlight: false,
    leaseUntil: kind === 'open' ? null : at(renewed ? g.pick([60_000, 1]) : g.pick([0, -1000])), verdict: g.pick([null, 'REJECT']), builtBy: g.pick([null, 'w1', 'w2']),
    frozenDigest: g.pick([null, 'd0']), parentId: g.pick([null, null, 5]), lane, route, diagnosed: seat === 'light' && route === 'light' ? true : g.pick([true, false]),
    holdReason: renewed && g.int(3) === 0 ? 'paused' : null, outside: g.pick([null, 'issue']), after: [60, 62].filter(() => g.int(2)), expectedMinutes: g.pick([null, 10, 30]), returnedRework: g.int(4) === 0 };
  if (renewed && g.int(3) === 0) Object.assign(item, { leaseUntil: at(g.pick([0, -1])), gateInFlight: true });
  const m = { id: ID, actor: 'w1', leaseMs: g.pick([60_000, 1_800_000]), itemFolder: g.pick([true, false, undefined]), autoNext: g.pick([true, false]), reviewSkipped: g.pick([null, 'docs only']),
    adoptCorrection: pending || g.int(2) === 0, routeCap: null, exitRules: g.pick([null, { ceiling: 0.8 }]), exitClaimKey: renewed && g.int(2) ? key('b') : key('a'), factId: 900 };
  const rework = item.verdict === 'REJECT' && item.builtBy === 'w1';
  const seatCap = g.pick([null, { n: 1, how: 'claims.perSeat sets 1' }, { n: 3, how: 'runners size 3' }]);
  // A child is free only beside its held parent (#10847): parent 5 is held for the item, parent 7 for every other child.
  const parentHeld = item.parentId !== null && g.int(2) === 0;
  const seatCapOn = !renewed && m.itemFolder === true && !parentHeld && !rework && Boolean(seatCap);
  const io = { checkoutOwner: null, coordinatorPaths: [], provesNothing: null, policyRefresh: g.pick([null, null, { before: 'p1', after: 'p2', changed: ['lanes'] }, { before: 'p1', after: 'p2' }]),
    reworkWindows: true, exitCeiling: item.owner === 'w1' && g.int(3) === 0 ? { message: 'ceiling' } : null, ledgerWritable: g.pick([true, undefined]), sessionCap: null, sessionSeats: [], laneSeat: null,
    primaryRoot: null, foreignBlocker: null, builderGone: blocks ? g.int(2) === 0 : g.int(4) === 0, buildBudgetMinutes: renewed && g.int(4) === 0 ? g.pick([0, Number.NaN, '30']) : g.pick([30, 45]),
    seatCap, freeze: { text: 'bar text', digest: 'd1' }, head: g.pick(['h1', null]), autoNextSnapshot: g.pick([null, { head: 'h1', digest: HEX }, { head: 'h2', digest: HEX }, { head: 'h1', digest: 'short' }]) };
  if (cap) g.int(2) ? (m.routeCap = cap) : (io.sessionCap = cap);
  const otherSeat = windows.at(-1)?.[2].reopenFirstRefusal?.otherSeatFirst;
  const deferred = { barProblem: null, reworkRouting: blocks && (otherSeat || !io.builderGone) ? { applies: true } : g.pick([null, { applies: false }]), exitContinuation: null, lineCapacity: null,
    submitAdmission: g.pick([null, { admitted: 1 }]), submitOutcome: g.pick([null, { outcome: 2 }]) };
  const top = Array.from({ length: g.int((renewed ? 3 : seatCapOn ? seatCap.n : m.itemFolder === true || parentHeld || rework ? 3 : 1)) },
    (_, i) => claim(90 + i, g.pick([{}, { verdict: 'REJECT', builtBy: 'w2' }, { builtBy: 'w1' }])));
  const extras = [claim(7, { awaitingGateOrReview: true }), ...(parentHeld ? [claim(5, { awaitingGateOrReview: true })] : []), ...(g.int(3) ? [] : [claim(ID)]), ...(g.int(3) ? [] : [claim(81, { leaseUntil: g.pick([at(-1), at(0)]) })]), ...(g.int(3) ? [] : [claim(82, { awaitingGateOrReview: true })])];
  const rework83 = g.int(3) ? [] : [claim(83, { verdict: 'REJECT', builtBy: 'w1' })];
  const children = Array.from({ length: g.int(4) === 0 ? 9 - top.length - rework83.length : g.int(2) }, (_, i) => claim(100 + i, { parentId: 7 }));
  const s = { now: NOW, actor: { id: 'w1', lane, route: actorRoute, model: g.pick([undefined, 'sonnet']), joined: true }, item,
    items: { 60: { status: 'verified', lane: 'core' }, 62: { status: 'withdrawn', lane: 'view' }, 70: { status: 'withdrawn' }, 71: { status: 'verified', merged: true } },
    claimWaiting: [70, 71, 72].filter(() => g.int(2)), laneHold: renewed && g.int(3) === 0 ? { by: 'coordinator', reason: 'r' } : null,
    actorClaims: [...extras, ...top, ...rework83, ...children].sort(() => g.rand() - 0.5), history, usedExitKeys: [key('b')], io, deferred };
  const adopts = m.adoptCorrection === true && pending, refreshes = Boolean(io.policyRefresh) && !adopts;
  const k = { renewed, pending, adopts, refreshes, freezes: item.frozenDigest === null || adopts || refreshes, seatCapOn, parentHeld, rework, live: top.length + rework83.length + children.length,
    top: s.actorClaims.filter(c => top.includes(c)).map(c => c.id) };
  return { s, m, k };
}

/** One way to break each guard of an accepted claim: whether it applies, the change, and the row, message and next step the refusal must carry. */
const BREAKS = [
  { row: 'checkout-is-mine', apply: (g, s) => { s.io.checkoutOwner = 'seat-9'; return { message: 'this checkout belongs to seat-9 in another agent session' }; } },
  { row: 'no-coordinator-path', apply: (g, s) => { Object.assign(s.io, { coordinatorPaths: ['a.md', 'b'], coordinatorPathsNext: 'ask' }); return { message: `the bar names a.md, b, which no lane owns, so lane ${s.item.lane} cannot build it`, next: 'ask' }; } },
  { row: 'check-proves-something', apply: (g, s) => { s.io.provesNothing = { message: 'green' }; return { message: 'green' }; } },
  { row: 'policy-contains-frozen', apply: (g, s) => { s.io.policyRefresh = { refused: 'moved' }; return { message: 'moved' }; } },
  { row: 'rework-windows', apply: (g, s) => { s.item.returnedRework = true; s.io.reworkWindows = null; } },
  { row: 'exit-ceiling', when: (s) => s.item.owner !== 'w1', apply: (g, s) => { s.io.exitCeiling = { message: 'full' }; return { message: 'full' }; } },
  { row: 'session-ledger', apply: (g, s) => { s.io.ledgerWritable = false; } },
  { row: 'joined', apply: (g, s) => {
    s.actor.joined = false;
    if (g.int(2)) return { message: `this worktree has not joined a lane; run ${JOIN}`, next: CLAIM_NEXT.NOT_JOINED };
    s.io.sessionSeats = [{ id: 'w7', lane: 'view', path: "/s/it's" }];
    return { message: "this checkout has no seat, and your session's seats work in their own checkouts: w7 (view lane) in /s/it's", next: `continue in that seat: cd '/s/it'\\''s' && pullboard next; or give this checkout its own seat: ${JOIN}` };
  } },
  { row: 'item-exists', apply: (g, s) => { s.item = null; s.io.exitCeiling = null; return { message: `no item #${ID}; see: pullboard list` }; } },
  { row: 'in-state', apply: (g, s) => { s.item.status = g.pick(['submitted', 'verified', 'withdrawn']); s.io.exitCeiling = null; return { message: `item #${ID} is ${s.item.status}` }; } },
  ...['UNDECLARED_BUILDER_FAMILY', 'BAR_NOT_READY'].map(code => ({ row: `bar-ready-${code.toLowerCase().replaceAll('_', '-')}`, apply: (g, s) => { s.deferred.barProblem = { code, message: 'bar' }; } })),
  { row: 'item-not-held', when: (s, k) => !k.renewed, apply: (g, s) => { s.item.holdReason = 'paused'; } },
  { row: 'outside-source', apply: (g, s) => { s.item.outside = 'pull-request'; } },
  { row: 'in-lane', apply: (g, s) => {
    const other = s.actor.lane === 'core' ? 'view' : 'core', was = s.actor.lane, variant = g.int(5);
    if (variant === 0) { s.actor.lane = 'coordinator'; return { message: `item #${ID} is in the ${was} lane, and lane items are built from that lane's worktree, never the main checkout. An agent runs: cd <its own worktree> && pullboard claim ${ID}`, next: CLAIM_NEXT.WRONG_LANE }; }
    if (variant === 1) { s.item.lane = 'coordinator'; return { message: `item #${ID} is in the coordinator lane; you are in ${was}`, next: CLAIM_NEXT.WRONG_LANE }; }
    if (variant === 2) { Object.assign(s.actor, { route: 'light' }); Object.assign(s.item, { lane: other, route: 'strong' }); return { message: `item #${ID} is in the ${other} lane; you are in ${was}`, next: CLAIM_NEXT.WRONG_LANE }; }
    s.item.lane = other;
    const head = `item #${ID} is in the ${other} lane; this checkout is in ${was}`;
    if (variant === 3) {
      const [path, cd] = g.pick([['/seats/w5', 'cd /seats/w5 &&'], ["/my seats/w'5", "cd '/my seats/w'\\''5' &&"]]);
      s.io.laneSeat = { agent: 'w5', path };
      return { message: `${head}. Build it in w5 at ${path}`, next: `${cd} pullboard claim ${ID}` };
    }
    s.io.primaryRoot = g.pick([null, '/repo']);
    return { message: `${head}. No seat was opened; open one in the ${other} lane and claim it there`,
      next: `${s.io.primaryRoot ? 'cd /repo && ' : ''}pullboard worktree ${other} --model "${s.actor.model ?? '<model name>'}", then in that worktree: pullboard claim ${ID}` };
  } },
  { row: 'light-diagnosed', apply: (g, s, m) => { Object.assign(s.actor, { route: 'light' }); Object.assign(s.item, { route: 'light', diagnosed: false }); m.routeCap = s.io.sessionCap = null; } },
  { row: 'abilities-cover-needs', apply: (g, s) => { s.item.needs = ['browser', 'gui']; s.actor.abilities = ['gui']; return { message: `item #${ID} needs browser, which this seat's abilities lack` }; } },
  { row: 'route-allows', apply: (g, s, m) => {
    const variant = g.int(3);
    s.item.route = variant === 2 ? 'mid' : g.pick(['mid', 'strong']);
    if (variant === 1) { s.actor.route = g.pick(['strong', undefined]); [m.routeCap, s.io.sessionCap] = g.pick([['light', null], [null, 'light'], ['light', 'strong']]); }
    else { s.actor.route = 'light'; [m.routeCap, s.io.sessionCap] = [variant === 2 ? 'strong' : null, null]; }
    return { message: `item #${ID} needs a ${s.item.route} model; ${variant === 1 ? 'the model this session declared serves' : 'you joined on'} the light route. Take your next item: pullboard next` };
  } },
  { row: 'budget-valid', when: (s, k) => !k.renewed, apply: (g, s) => { s.io.buildBudgetMinutes = g.pick([0, -5, Number.NaN, Number.POSITIVE_INFINITY, '30', undefined]); } },
  { row: 'build-scope', when: (s, k) => !k.renewed, apply: (g, s) => { s.item.expectedMinutes = s.io.buildBudgetMinutes + 1; } },
  { row: 'dependencies', apply: (g, s) => {
    const variant = g.int(3);
    if (variant === 0) { s.io.foreignBlocker = { label: 'other#3', status: 'open' }; return { message: `#${ID} waits on other#3 (open on its own board); refresh that board before claiming` }; }
    if (variant === 1) { s.claimWaiting.push(73); s.items[73] = { status: 'open' }; return { message: `#${ID} is waiting on #73 to land; it returns to the queue when that lands` }; }
    const [dep, shown] = g.pick([[{ status: 'submitted' }, 'submitted'], [{ status: 'claimed', leaseUntil: at(60_000) }, 'claimed'], [{ status: 'claimed', leaseUntil: at(0) }, 'open'], [{ status: 'claimed', leaseUntil: at(-1), gateInFlight: true }, 'claimed']]);
    s.items[61] = { ...dep, lane: 'view' }; s.item.after.push(61);
    return { message: `#${ID} waits on #61 (${shown}, view lane); claim another item, or shout view if it is stuck` };
  } },
  { row: 'not-held-by-another', when: (s, k) => !k.renewed && s.item.owner !== 'w1', apply: (g, s) => {
    Object.assign(s.item, { status: 'claimed', owner: 'w2', ...g.pick([{ leaseUntil: at(60_000) }, { leaseUntil: at(-1), gateInFlight: true }]) });
    return { message: `item #${ID} is held by w2 until ${s.item.leaseUntil}` };
  } },
  { row: 'exit-continuation', apply: (g, s) => { s.deferred.exitContinuation = { message: 'family' }; return { message: 'family' }; } },
  ...['REOPEN_HELD_FOR_BUILDER', 'NO_POLICY'].map(code => ({ row: `rework-routing-${code.toLowerCase().replaceAll('_', '-')}`, apply: (g, s) => { s.deferred.reworkRouting = { refused: { code, message: 'rw' } }; return { message: 'rw' }; } })),
  { row: 'first-refusal', apply: (g, s) => {
    const [events] = g.pick(WINDOWS.filter(([, blocks]) => blocks)), id = s.history.length + 1;
    s.deferred.reworkRouting = null; s.io.builderGone = false;
    s.history.push(...events.map(([kind, by, detail], i) => ({ id: id + i, kind, by, detail })));
    return { message: events.at(-1)[2].reopenFirstRefusal?.otherSeatFirst ? `item #${ID} returned for lack of progress; a reviewer of it cannot take the first refusal; take another item`
      : `item #${ID} waits for w4 until ${at(3_600_000)}; claim it after that time, or ask its builder to release it` };
  } },
  { row: 'correction-refrozen', apply: (g, s, m, k) => {
    const [fields, said] = g.pick([[['check'], 'check'], [['criterion', 'after'], 'after and criterion']]);
    s.history.push({ id: s.history.length + 1, kind: 'edit', by: 'coordinator', detail: { pendingRefreeze: fields } }); m.adoptCorrection = false;
    return k.pending ? {} : { message: `item #${ID} has a pending ${said} correction; refreeze it before renewing or submitting.\nnext: pullboard refreeze ${ID}` };
  } },
  { row: 'lane-open', when: (s, k) => !k.renewed, apply: (g, s) => { s.laneHold = { by: 'coordinator', reason: 'freeze' }; return { message: `coordinator holds the ${s.item.lane} lane: freeze; take other available work with pullboard next, or end your turn if none is offered` }; } },
  { row: 'line-capacity', apply: (g, s) => { s.deferred.lineCapacity = { message: 'line full' }; return { message: 'line full' }; } },
  { row: 'one-live-claim', when: (s, k) => !k.renewed, apply: (g, s, m, k) => {
    const single = m.itemFolder !== true && !k.parentHeld && !k.rework && k.live < 9, capped = k.seatCapOn && k.live + s.io.seatCap.n - k.top.length < 10;
    const variant = g.pick(['ten', ...(single ? ['single'] : []), ...(capped ? ['cap'] : [])]);
    if (variant === 'single') { s.actorClaims.push(claim(95, g.pick([{}, { builtBy: 'w1' }, { verdict: 'REJECT', builtBy: 'w2' }]))); return { message: 'you already hold #95; submit or release it first (children of an item you hold are free)' }; }
    if (variant === 'cap') {
      const ids = [...k.top, ...Array.from({ length: s.io.seatCap.n - k.top.length }, (_, i) => 95 + i)];
      s.actorClaims.push(...ids.slice(k.top.length).map(id => claim(id)));
      return { message: `you already hold ${ids.map(id => `#${id}`).join(', ')}; a seat holds up to ${s.io.seatCap.n} (${s.io.seatCap.how}); submit or release one first (children of an item you hold are free)` };
    }
    s.actorClaims.push(...Array.from({ length: 10 - k.live }, (_, i) => claim(120 + i, { parentId: 7 })));
    return { message: 'you already hold ten live claims; submit or release one before claiming another' };
  } },
  ...['UNKNOWN_SPEC', 'A5_GRAMMAR_VERSION', 'NO_POLICY', 'BAD_CONFIG', 'AGENT_APPROVAL_REQUIRED', 'BAR_NOT_READY', 'BAR_EMPTY', 'CHECK_OVER_CEILING'].map(code => ({ row: `rows-in-force-${code.toLowerCase().replaceAll('_', '-')}`,
    when: (s, k) => k.freezes, apply: (g, s) => { s.io.freeze = { refused: { code, message: 'frozen' } }; return { message: 'frozen' }; } })),
  { row: 'exit-key', apply: (g, s, m, k) => { m.exitRules = { ceiling: 0.8 }; m.exitClaimKey = !k.renewed && g.int(2) ? key('b') : g.pick(['nope', null, key('a').toUpperCase()]); } },
];

/** Break one guard of `c` on a copy, returning the broken case and what its refusal must say. */
function broken(c, b, g) {
  const s = structuredClone(c.s), m = structuredClone(c.m);
  return { s, m, row: b.row, want: b.apply(g, s, m, c.k) ?? {} };
}

const CASES = 10_000;
const results = Array.from({ length: CASES }, (_, i) => {
  const g = seeded(i + 1), c = base(g);
  const usable = BREAKS.filter(b => !b.when || b.when(c.s, c.k));
  const made = g.int(5) < 2 ? { ...c, row: null, want: {} } : { ...c, ...broken(c, g.pick(usable), g) };
  return { seed: i + 1, ...made, result: run(made.s, made.m) };
});
const ok = results.filter(c => !c.row);
const GRANT = ok.find(c => !c.result.refused).result.events[0].detail.grantEngine;

/** The claim rule restated apart from the table: the item fields it writes, its event detail, and the two follow-ups. */
function expected({ s, m, k }) {
  const fresh = !k.renewed, freeze = k.freezes ? s.io.freeze : null, lease = at(m.leaseMs), digest = freeze ? freeze.digest : s.item.frozenDigest, snap = s.io.autoNextSnapshot;
  const detail = { leaseUntil: lease, digest, grantEngine: GRANT, ...(fresh && m.autoNext && snap?.head === s.io.head && snap.digest === HEX && { autoNextSnapshot: snap }),
    ...(fresh && m.itemFolder === true && { itemFolder: true }), ...(k.seatCapOn && { claimsPerSeat: s.io.seatCap.n }), ...(fresh && m.exitRules && { exitRules: m.exitRules, exitClaimKey: m.exitClaimKey }),
    ...(k.adopts && { adoptedCorrection: digest }), ...(k.refreshes && { policyRefreshed: digest }), ...(fresh && m.reviewSkipped && { reviewSkipped: m.reviewSkipped }),
    ...(fresh && s.item.expectedMinutes != null && { buildBudgetMinutes: s.io.buildBudgetMinutes, expectedBuildMinutes: s.item.expectedMinutes }),
    ...(s.deferred.submitAdmission && { submitAdmission: s.deferred.submitAdmission }), ...(s.deferred.submitOutcome && { submitOutcome: s.deferred.submitOutcome }) };
  const named = fresh && k.refreshes && Array.isArray(s.io.policyRefresh.changed), anchored = fresh && Boolean(m.exitRules);
  return { patch: { status: 'claimed', owner: 'w1', leaseUntil: lease, ...(freeze && { frozen: freeze.text, frozenDigest: freeze.digest }), ...(fresh && s.io.head && { claimHead: s.io.head }),
    ...(anchored && { meta: { [`exit-claim-key:${m.exitClaimKey}`]: { item: ID, agent: 'w1' }, [`exit-handoff:${ID}`]: null } }) },
  events: [{ kind: fresh ? 'claim' : 'renew', by: 'w1', detail }, ...(named ? [{ kind: 'fact', by: 'w1', detail: { id: 900, kind: 'note', text: 'policy re-frozen automatically: p1 -> p2; only lanes changed', ref: null, supersedes: null } }] : [])],
  via: [fresh ? 'claim' : 'renew', ...(named ? ['policy-refrozen-fact'] : []), ...(anchored ? ['exit-anchor'] : [])] };
}

test('moves.claim-generated.moves-claim-rows-fire-generated-every-guard-outcome-and-follow-up: moves.claim.rows-fire: generated: every guard, outcome and follow-up row of the claim table fires on some seeded case [C7,#8264]', () => {
  const fired = new Set(results.flatMap(c => (c.result.refused ? [c.result.refused.row] : c.result.via)));
  const rows = [...TABLE.guards, ...TABLE.outcomes, ...TABLE.followups].map(row => row.id);
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
  assert.deepEqual(BREAKS.map(b => b.row).sort(), TABLE.guards.map(row => row.id).sort());
  assert.ok(ok.length > CASES / 3, `only ${ok.length} unbroken claims`);
});

test('moves.claim-generated.moves-claim-accepted-claims-generated-every-unbroken-claim-is-accepted: moves.claim.accepted-claims: generated: every unbroken claim is accepted, with the patch, events and follow-ups the restated rule gives [C7,#8264]', () => {
  assert.ok(Number.isSafeInteger(GRANT) && GRANT >= 1, `grant engine ${GRANT}`);
  for (const c of ok) assert.deepEqual(c.result, expected(c), `seed ${c.seed}`);
});

test('moves.claim-generated.moves-claim-refusal-writes-nothing-generated-a-refusal-writes-nothing-and: moves.claim.refusal-writes-nothing: generated: a refusal writes nothing and carries its row, code, message and the CLAIM_NEXT step for its code [C7,#8264]', () => {
  const own = new Set(['checkout-is-mine', 'no-coordinator-path', 'joined', 'in-lane', 'build-scope']);
  for (const c of results.filter(each => each.result.refused)) {
    const { refused } = c.result, row = TABLE.guards.find(each => each.id === refused.row);
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}`);
    assert.deepEqual([refused.row, refused.code], [c.row, row.code], `seed ${c.seed}`);
    assert.ok(typeof refused.message === 'string' && refused.message.length > 0, `seed ${c.seed}: ${refused.row}`);
    if (c.want.message) assert.equal(refused.message, c.want.message, `seed ${c.seed}: ${refused.row}`);
    assert.equal(refused.next, c.want.next ?? (own.has(row.id) ? refused.next : CLAIM_NEXT[row.code] ?? 'run pullboard help'), `seed ${c.seed}: ${refused.row}`);
  }
});

test('moves.claim-generated.moves-claim-deterministic-generated-the-table-is-deterministic-reads: moves.claim.deterministic: generated: the table is deterministic, reads its snapshot without changing it, and agrees with claimEngine at the same grant engine [C7,#8264]', () => {
  const same = claimEngine({ grantEngine: GRANT });
  for (const c of results.slice(0, 2000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.m);
    assert.deepEqual(runTable(TABLE, RULES, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.m], `seed ${c.seed}`);
    assert.deepEqual(runTable(same.table, same.rules, structuredClone(c.s), structuredClone(c.m)), c.result, `seed ${c.seed}`);
  }
});

test('moves.claim-generated.moves-claim-guard-breaks-metamorphic-break-any-one-guard-fact: moves.claim.guard-breaks: metamorphic: break any one guard fact of an accepted claim and it refuses at that row with the words the command prints [C7,#8264]', () => {
  for (const c of ok.slice(0, 400)) {
    BREAKS.filter(b => !b.when || b.when(c.s, c.k)).forEach((b, i) => {
      const bad = broken(c, b, seeded(c.seed * 97 + i)), { refused } = run(bad.s, bad.m);
      assert.equal(refused?.row, b.row, `seed ${c.seed}: breaking ${b.row}`);
      if (bad.want.message) assert.equal(refused.message, bad.want.message, `seed ${c.seed}: ${b.row}`);
    });
  }
});

test('moves.claim-generated.moves-claim-uncounted-facts-metamorphic-claims-that-do-not-count: moves.claim.uncounted-facts: metamorphic: claims that do not count, settled waits, an untracked edit and a freeze refusal that is never read leave an accepted claim unchanged [C7,#8264]', () => {
  const irrelevant = [
    (s) => s.actorClaims.push(claim(ID), claim(84, { leaseUntil: at(0) }), claim(85, { awaitingGateOrReview: true })),
    (s) => { s.item.after.push(60, 62); s.claimWaiting.push(70, 71); },
    (s) => s.history.push({ id: s.history.length + 1, kind: 'edit', by: 'coordinator', detail: { pendingRefreeze: ['title'] } }),
    (s, k) => { if (!k.freezes) s.io.freeze = { refused: { code: 'UNKNOWN_SPEC', message: 'never read' } }; },
    (s, k) => { if (k.renewed) Object.assign(s, { laneHold: { by: 'coordinator', reason: 'r' } }, { item: { ...s.item, holdReason: 'paused' } }); },
  ];
  for (const c of ok.slice(0, 1000)) {
    for (const change of irrelevant) {
      const s = structuredClone(c.s);
      change(s, c.k);
      assert.deepEqual(run(s, c.m), c.result, `seed ${c.seed}: ${change}`);
    }
  }
});

test('moves.claim-generated.moves-claim-table-inputs-generated-claim-engine-refuses-claim-table-inputs-without-a: moves.claim.table-inputs: generated: claimEngine refuses CLAIM_TABLE_INPUTS without a whole grant engine of at least one [C7,#8264]', () => {
  for (const board of [undefined, {}, { grantEngine: 0 }, { grantEngine: -1 }, { grantEngine: 1.5 }, { grantEngine: '1' }, { grantEngine: Number.NaN }]) {
    assert.throws(() => claimEngine(board), { code: 'CLAIM_TABLE_INPUTS' }, JSON.stringify(board));
  }
  for (const grantEngine of [1, 2, GRANT]) assert.equal(typeof claimEngine({ grantEngine }).table, 'object');
});

/** A snapshot of one open child claim at seat cap 1 with the actor holding `held`, over the first accepted seeded claim to take its shape from. */
function childClaim(held) {
  const { s, m } = ok.find(c => !c.k.renewed && c.s.item.status === 'open' && c.s.item.verdict !== 'REJECT');
  const child = { ...s.item, status: 'open', owner: null, leaseUntil: null, verdict: null, builtBy: null, parentId: 5 };
  return { s: { ...s, item: child, actorClaims: held, io: { ...s.io, seatCap: { n: 1, how: 'claims.perSeat sets 1' }, policyRefresh: null, provesNothing: null, exitCeiling: null }, history: [], claimWaiting: [] },
    m: { ...m, itemFolder: true, adoptCorrection: false, exitRules: null, routeCap: null } };
}

test('moves.claim-generated.child-of-unheld-parent-counts: clause 1: at seatCap 1 a held child of a parent the actor does not hold fills the seat, as the claim writer does [C7,#10847]', () => {
  const held = [claim(91, { parentId: 5 })];
  for (const itemFolder of [true]) {
    const { s, m } = childClaim(held);
    m.itemFolder = itemFolder;
    assert.equal(run(s, m).refused?.row, 'one-live-claim', 'a second child of the unheld parent is refused');
    assert.equal(run(s, m).refused.message, 'you already hold #91; a seat holds up to 1 (claims.perSeat sets 1); submit or release one first (children of an item you hold are free)');
  }
  const top = childClaim([claim(92)]);
  top.s.item.parentId = null;
  assert.equal(run(top.s, top.m).refused.message, 'you already hold #92; a seat holds up to 1 (claims.perSeat sets 1); submit or release one first (children of an item you hold are free)');
  const single = childClaim([claim(93, { parentId: 5 })]);
  single.m.itemFolder = false;
  single.s.item.parentId = null;
  assert.equal(run(single.s, single.m).refused.message, 'you already hold #93; submit or release it first (children of an item you hold are free)');
});

test('moves.claim-generated.child-of-own-parent-free: clause 2: an actor holding the parent claims its children with no refusal [C7,#10847]', () => {
  const held = [claim(5), claim(91, { parentId: 5 })];
  const { s, m } = childClaim(held);
  assert.equal(run(s, m).refused, undefined, 'the child beside its held parent is free at seatCap 1');
  const plain = childClaim(held);
  plain.m.itemFolder = false;
  plain.s.actorClaims = [claim(5, { awaitingGateOrReview: true })];
  assert.equal(run(plain.s, plain.m).refused, undefined, 'the held parent never counts against its child');
});
