/** Tests generated from the release table: every guard and outcome row over thousands of seeded releases, checked against the rule restated here, and metamorphic breaks that must refuse or must not matter [C7,#8264]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardReleaseEngine } from '../../../index.js';
import { releaseEngine } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';

const { rules: RULES, table: TABLE } = boardReleaseEngine();
const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const ID = 7, HOLDER = 'core-1', SEAT = '/seats/core-1', LS = String.fromCharCode(0x2028);
const iso = (ms) => new Date(ms).toISOString();
const run = (snapshot, move) => runTable(TABLE, RULES, structuredClone(snapshot), structuredClone(move));

/** The board's reasons and stale limits, restated: an idle claim waits 1 h, a blocker 15 min, and health.stuck sets both. */
const KNOWN = ['INELIGIBLE', 'ROUTED_ELSEWHERE', 'BLOCKED', 'BUDGET', 'TAKEN_OVER', 'DIAGNOSIS_WRONG', 'INFRA', 'OTHER'];
const QUALITY = ['BLOCKED', 'BUDGET', 'INELIGIBLE'];
const limitOf = (c) => (c.health ? 1_800_000 : c.staleClaim.blocker === true ? 900_000 : 3_600_000);
const SHOUT = 'shout its holder or the coordinator: pullboard shout coordinator --kind question "<what you need>"';
const REASON = 'name why with --reason INELIGIBLE|ROUTED_ELSEWHERE|BLOCKED|BUDGET|TAKEN_OVER|DIAGNOSIS_WRONG|OTHER (OTHER also needs --note)';
const DIAG = 'claim the diagnosed item, then release it with --reason DIAGNOSIS_WRONG --note "<what was wrong>"', NO_ITEM = 'find the item id: pullboard list --all';
const JOIN = 'pullboard join <lane> --model "<model name>"';
/** Each guard row's code and next step, restated; null where the next step names the caller's own seat or checkout. */
const ROWS = {
  'checkout-is-mine': ['NOT_YOUR_CHECKOUT', 'continue in your own checkout: pullboard next'], joined: ['NOT_JOINED', `join a lane from this worktree: ${JOIN} (see: pullboard lanes)`], 'on-needs-blocked': ['USAGE', 'run pullboard help'],
  'on-is-ids': ['BAD_DEPENDENCIES', 'pass one or more existing local item ids with --on, or omit --on'], 'stale-coordinator-only': ['NOT_YOURS', SHOUT],
  'stale-reason-known': ['RELEASE_REASON', REASON], 'stale-diagnosis-note': ['DIAGNOSIS_WRONG', DIAG], 'stale-other-note': ['RELEASE_REASON', REASON],
  'stale-note': ['NOTE_REQUIRED', 'add --note "<what happened>"'], 'stale-observed': ['NOT_YOURS', SHOUT], 'item-exists': ['NO_ITEM', NO_ITEM], 'not-held-elsewhere': ['NOT_YOURS', null],
  'reason-known': ['RELEASE_REASON', REASON], 'diagnosis-note': ['DIAGNOSIS_WRONG', DIAG], 'other-note': ['RELEASE_REASON', REASON],
  'review-note': ['NOTE_REQUIRED', 'give the review release a one-line reason with --note "..."'], 'on-claim-mine': ['NOT_YOURS', SHOUT], 'on-found': ['NO_ITEM', NO_ITEM],
  'on-not-withdrawn': ['WITHDRAWN', 'unobserved'], 'on-no-cycle': ['DEPENDENCY_CYCLE', 'change --after so no item waits on itself'], 'diagnosis-held': ['DIAGNOSIS_WRONG', DIAG],
  'stale-valid': ['NOT_YOURS', SHOUT], 'review-mine': ['NOT_YOURS', SHOUT], 'claim-mine': ['NOT_YOURS', SHOUT],
};
const WHY = { changed: 'the claim changed after the stale observation; capture it again before releasing', evidence: 'complete activity evidence does not establish the configured stale interval',
  wait: 'the expired lease has not passed its configured stale interval; wait for that interval before releasing', lease: 'the claim lease changed after the stale observation; capture it again' };

/** Earlier episodes on the item and what each adds to the release-twice count: a quality release chosen by its own claimer, unflagged, without a structured blocker (--on) and not caused by infrastructure, counts. */
const FLAGS = ['review', 'staleClaim', 'goneSeat', 'idleClaim', 'expiredClaim', 'untouchedAutoClaim', 'exitHandoff'];
const EPISODES = [
  [[['claim', 'a'], ['release', 'a', { reasonCode: 'BUDGET', reason: 'too big' }]], 1], [[['claim', 'a'], ['release', 'a', { reasonCode: 'BLOCKED' }]], 1],
  [[['claim', 'a'], ['release', 'a', { reasonCode: 'INELIGIBLE' }]], 1], [[['claim', 'a'], ['release', 'a', { reasonCode: 'INFRA' }]], 0],
  [[['claim', 'a'], ['release', 'a', { reasonCode: 'TAKEN_OVER' }]], 0], ...FLAGS.map(flag => [[['claim', 'a'], ['release', 'a', { reasonCode: 'BLOCKED', [flag]: true }]], 0]),
  [[['claim', 'a'], ['submit-handoff', 'a', { state: 'infrastructure' }], ['release', 'a', { reasonCode: 'BLOCKED' }]], 0],
  [[['submit-handoff', 'a', { state: 'infrastructure' }], ['claim', 'a'], ['release', 'a', { reasonCode: 'BUDGET' }]], 1],
  [[['claim', 'a'], ['submit-handoff', 'b', { state: 'infrastructure' }], ['release', 'a', { reasonCode: 'BLOCKED' }]], 1],
  [[['claim', 'a'], ['submit-handoff', 'a', { state: 'ready' }], ['release', 'a', { reasonCode: 'BLOCKED' }]], 1],
  [[['claim', 'b'], ['release', 'a', { reasonCode: 'BUDGET' }]], 0], [[['claim', 'a'], ['submit', 'a'], ['release', 'a', { reasonCode: 'BUDGET' }]], 0],
  [[['unhold_item', 'c']], 'reset'], [[['escalate', 'c', { from: 'light', to: 'mid' }]], 'reset'], [[['escalate', 'c', { from: 'strong', to: 'strong' }]], 0],
];
const NOTES = [undefined, '', '  ', 'stuck on fixtures', '  padded  ', 'two\nlines', 'tail\n', `a${LS}b`];
const ONS = [[8], [9], [8, 9], [99], [10], [11], [7], [], [8.5], ['8']];
const SEATS = [{ id: 'core-9', lane: 'core', path: "/w/it's" }, { id: 'core-8', lane: 'view', path: '/w/b' }];

/** One fact of a coordinator's stale observation broken, or none; some breaks leave it valid (a gone seat folder skips the evidence). */
const STALE_BREAKS = {
  status: (s) => { s.item.status = 'open'; }, owner: (s) => { s.item.owner = 'core-2'; }, itemId: (s) => { s.item.id = 8; }, claimId: (s) => { s.ownerLastClaimId = 49; },
  rowLease: (s, m) => { m.stale.staleClaim.leaseUntil = iso(NOW + 5); }, noLapse: (s, m) => { m.stale.leaseLapse = false; }, revision: (s, m) => { m.stale.observedRevision = 2; },
  leaseNow: (s, m) => { s.item.leaseUntil = m.now; m.stale.staleClaim.leaseUntil = m.now; m.stale.leaseLapse = false; },
  loose: (s, m) => { m.stale.observedAt = m.stale.observedAt.replace('.000Z', 'Z'); }, future: (s, m) => { m.stale.observedAt = iso(NOW + 1); },
  lastAfter: (s, m) => { m.stale.staleClaim.lastActivity = iso(Date.parse(m.stale.observedAt) + 1); }, lastLoose: (s, m) => { m.stale.staleClaim.lastActivity = 'yesterday'; },
  incomplete: (s, m) => { m.stale.staleClaim.evidence = { complete: 'true' }; }, limitMs: (s, m) => { m.stale.staleClaim.limitMs += 1; },
  short: (s, m) => { m.stale.staleClaim.lastActivity = iso(Date.parse(m.stale.observedAt) - m.stale.staleClaim.limitMs + 1); },
  blocker: (s, m) => { m.stale.staleClaim.blocker = !m.stale.staleClaim.blocker; }, health: (s, m) => { m.stale.health = { stuck: '15m' }; },
  leaseShort: (s, m) => { s.item.leaseUntil = iso(Date.parse(m.stale.observedAt) - m.stale.staleClaim.limitMs + 1); m.stale.staleClaim.leaseUntil = s.item.leaseUntil; },
  leaseId: (s) => { s.ownerLastLease &&= { ...s.ownerLastLease, id: 61 }; }, leaseAt: (s, m) => { m.stale.staleClaim.leaseStartedAt = iso(0); }, leaseMs: (s, m) => { m.stale.staleClaim.leaseMs += 1; },
  leaseEnd: (s) => { s.ownerLastLease &&= { ...s.ownerLastLease, leaseUntil: iso(0) }; }, noLease: (s) => { s.ownerLastLease = null; },
  zeroLease: (s, m) => { s.ownerLastLease &&= { ...s.ownerLastLease, at: s.item.leaseUntil }; m.stale.staleClaim.leaseStartedAt = s.item.leaseUntil; m.stale.staleClaim.leaseMs = 0; },
  folder: (s, m) => { m.stale.staleClaim.seatFolderMissing = SEAT; }, staleId: (s, m) => { m.stale.staleClaim.id = 8; }, stranger: (s, m) => { m.actor = 'core-2'; },
};

/** One seeded release, biased so every row fires: holders, reviewers, strangers, the first-refusal window, --on graphs, untouched auto-claims, history and stale observations. */
function scenario(seed) {
  const g = seeded(seed);
  const status = g.pick(['claimed', 'claimed', 'claimed', 'submitted', 'open']);
  const stale = status === 'claimed' && g.int(3) === 0;
  const actor = stale ? g.pick(['coordinator', 'coordinator', 'core-2']) : g.pick([HOLDER, HOLDER, HOLDER, 'core-2', 'coordinator']);
  const item = { id: ID, status, owner: status === 'claimed' ? HOLDER : null, route: g.pick(['light', 'mid', 'strong']), after: g.pick([[], [8]]),
    leaseUntil: status === 'claimed' ? iso(NOW + 3_600_000) : null, holdReason: g.int(5) === 0 ? 'held' : null, holdBy: null, reviewer: status === 'submitted' ? g.pick([actor, 'core-3']) : null };
  const items = { 7: { status, after: item.after }, 8: { status: 'open', after: [] }, 9: { status: 'open', after: [8] }, 10: { status: 'withdrawn', after: [] }, 11: { status: 'open', after: [7] } };
  const history = [], x = { counted: [], lateInfra: false };
  const add = (kind, by, detail = {}) => history.push({ id: history.length + 1, kind, by, detail });
  for (let n = g.int(5); n > 0; n--) {
    const [events, count] = g.int(2) ? EPISODES[g.int(3)] : g.pick(EPISODES);
    const a = g.pick([HOLDER, 'core-2']), who = { a, b: a === HOLDER ? 'core-2' : HOLDER, c: 'coordinator' };
    for (const [kind, by, detail] of events) add(kind, who[by], detail);
    if (count === 'reset') x.counted = []; else if (count === 1) x.counted.push({ by: who.a, code: history.at(-1).detail.reasonCode, reason: history.at(-1).detail.reason });
  }
  if (status === 'claimed') add('claim', HOLDER);
  if (status === 'claimed' && g.int(6) === 0) { add('submit-handoff', HOLDER, { state: 'infrastructure' }); x.lateInfra = true; }
  const s = { revision: 3, item, actor: { id: actor, route: g.pick(['light', 'mid', 'strong']), joined: g.int(12) === 0 ? false : g.pick([true, undefined]) },
    owner: status === 'claimed' && g.int(3) === 0 ? { sameSession: g.pick([true, false]), path: SEAT } : null, diagnosed: g.int(2) === 0,
    firstRefusalBuilder: status === 'open' ? g.pick([actor, 'core-3']) : null, items, history, ownerLastClaimId: 50, ownerLastLease: null, ownerRegisteredPath: SEAT,
    lastClaim: status === 'claimed' ? { id: history.length, kind: 'claim', by: g.pick([HOLDER, HOLDER, 'core-2']), detail: g.int(2) ? { autoNextSnapshot: { head: 'h1', digest: 'd1' } } : {} } : null,
    io: g.int(4) === 0 ? undefined : { checkoutOwner: g.int(15) === 0 ? 'session-b' : null, sessionSeats: g.int(2) ? [] : SEATS } };
  const m = { id: ID, actor, root: g.pick([SEAT, `${SEAT}-item-7`, '/elsewhere']), reason: g.pick([...KNOWN, ...QUALITY, 'BUDGET', 'NOPE']), note: g.pick(NOTES), now: iso(NOW),
    worktreeSnapshot: g.pick([undefined, { head: 'h1', digest: 'd1' }, { head: 'h1', digest: 'd1' }, { head: 'h2', digest: 'd1' }, { head: 'h1', digest: 'd2' }]) };
  if (g.int(4) === 0) m.on = g.pick(ONS);
  if (stale) {
    const blocker = g.int(2) === 0, health = g.int(3) === 0 ? { stuck: '30m' } : undefined, lapse = g.int(2) === 0, leaseMs = g.pick([1, 120_000]);
    const limit = health ? 1_800_000 : blocker ? 900_000 : 3_600_000, observed = NOW - g.pick([0, 1000]);
    const until = lapse ? observed - limit - g.pick([0, 0, 2000]) : NOW + g.pick([1, 3_600_000]);
    item.leaseUntil = iso(until);
    s.ownerLastLease = { id: 60, at: iso(until - leaseMs), leaseUntil: item.leaseUntil };
    const row = { id: ID, actor: HOLDER, leaseUntil: item.leaseUntil, claimEventId: 50, lastActivity: iso(observed - limit - g.pick([0, 0, 5000])), evidence: { complete: true },
      limitMs: limit, blocker, leaseEventId: 60, leaseStartedAt: s.ownerLastLease.at, leaseMs, ...(g.int(4) === 0 ? { seatFolderMissing: g.pick([SEAT, '/elsewhere']) } : {}) };
    m.stale = { staleClaim: row, observedAt: iso(observed), observedRevision: 3, leaseLapse: lapse || g.int(3) === 0, ...(health ? { health } : {}) };
    for (let n = g.pick([0, 0, 1, 1, 2]); n > 0; n--) g.pick(Object.values(STALE_BREAKS))(s, m);
  }
  if (g.int(40) === 0) s.item = null;
  return { s, m, x };
}

const blank = (note) => typeof note !== 'string' || note.trim() === '';
const broken = (note) => [13, 10, 0x2028, 0x2029].some(code => note.includes(String.fromCharCode(code)));
const trim = (note) => (typeof note === 'string' ? note.trim() : '');
const mine = (s, m) => s.item?.status === 'claimed' && s.item.owner === m.actor;
const canon = (value, max) => { const at = Date.parse(value); return Number.isFinite(at) && at <= max && new Date(at).toISOString() === value ? at : null; };

/** Why a stale observation cannot release, restated: it must still match the claim, prove the idle interval (unless the seat folder is gone), and for a lapsed lease match it too. */
function staleWhy(s, m) {
  const c = m.stale, row = c.staleClaim, limit = limitOf(c), gone = row.seatFolderMissing === s.ownerRegisteredPath;
  const same = s.item.status === 'claimed' && s.item.owner === row.actor && s.item.id === row.id && s.item.leaseUntil === row.leaseUntil && s.ownerLastClaimId === row.claimEventId;
  if (!same || c.observedRevision !== s.revision || !(c.leaseLapse === true || s.item.leaseUntil > m.now)) return WHY.changed;
  if (gone) return null;
  const seen = canon(c.observedAt, NOW), last = seen === null ? null : canon(row.lastActivity, seen);
  if (last === null || row.evidence?.complete !== true || row.limitMs !== limit || seen - last < limit) return WHY.evidence;
  if (c.leaseLapse !== true || s.item.leaseUntil > m.now) return null;
  if (seen - Date.parse(s.item.leaseUntil) < limit) return WHY.wait;
  const lease = s.ownerLastLease, ms = Date.parse(s.item.leaseUntil) - Date.parse(lease?.at);
  return lease?.id === row.leaseEventId && lease.at === row.leaseStartedAt && lease.leaseUntil === row.leaseUntil && row.leaseMs === ms && ms > 0 ? null : WHY.lease;
}

/** The --on refusal, restated: every direct dependency exists and is not withdrawn, and the item is not reachable from them. */
function dependency(s, m) {
  const direct = [...new Set([...s.item.after, ...m.on])];
  if (direct.some(id => !s.items[id])) return 'on-found';
  if (direct.some(id => s.items[id].status === 'withdrawn')) return 'on-not-withdrawn';
  const reach = new Set(direct);
  for (const id of reach) s.items[id].after.forEach(next => reach.add(next));
  return reach.has(m.id) ? 'on-no-cycle' : null;
}

/** The first guard row that refuses, restated in the order the command throws; null when the release goes through. */
function firstRefusal(s, m) {
  const st = Boolean(m.stale), on = m.on !== undefined, review = () => s.item.status === 'submitted';
  const checks = [
    ['checkout-is-mine', () => !s.io?.checkoutOwner], ['joined', () => s.actor.joined !== false], ['on-needs-blocked', () => !on || (m.reason === 'BLOCKED' && !st)],
    ['on-is-ids', () => !on || (m.on.length > 0 && m.on.every(Number.isInteger))], ['stale-coordinator-only', () => !st || m.actor === 'coordinator'],
    ['stale-reason-known', () => !st || KNOWN.includes(m.reason)], ['stale-diagnosis-note', () => !st || m.reason !== 'DIAGNOSIS_WRONG' || !blank(m.note)],
    ['stale-other-note', () => !st || m.reason !== 'OTHER' || !blank(m.note)], ['stale-note', () => !st || !(blank(m.note) || broken(m.note))],
    ['stale-observed', () => !st || m.stale.staleClaim.id === m.id], ['item-exists', () => Boolean(s.item)],
    ['not-held-elsewhere', () => st || !(s.item.status === 'claimed' && s.owner?.sameSession && ![s.owner.path, `${s.owner.path}-item-${m.id}`].includes(m.root))],
    ['reason-known', () => KNOWN.includes(m.reason)], ['diagnosis-note', () => m.reason !== 'DIAGNOSIS_WRONG' || !blank(m.note)], ['other-note', () => m.reason !== 'OTHER' || !blank(m.note)],
    ['review-note', () => !(review() && s.item.reviewer === m.actor && (blank(m.note) || broken(trim(m.note))))], ['on-claim-mine', () => !on || mine(s, m)],
    ...['on-found', 'on-not-withdrawn', 'on-no-cycle'].map(row => [row, () => !on || dependency(s, m) !== row]),
    ['diagnosis-held', () => m.reason !== 'DIAGNOSIS_WRONG' || (s.diagnosed && mine(s, m))], ['stale-valid', () => !st || staleWhy(s, m) === null],
    ['review-mine', () => !review() || s.item.reviewer === m.actor], ['claim-mine', () => st || review() || mine(s, m) || (s.item.status === 'open' && s.firstRefusalBuilder === m.actor)],
  ];
  return checks.find(([, holds]) => !holds())?.[0] ?? null;
}

/** The accepted release, restated: a review frees its reviewer, a stale release records its evidence, a claim goes back open; then route calibration and release-twice. */
function expected(s, m, x) {
  const note = trim(m.note), release = (detail) => ({ kind: 'release', by: m.actor, detail: { ...detail, reasonCode: m.reason } });
  if (s.item.status === 'submitted') return { patch: { reviewer: null }, events: [release({ review: true, reason: note })], via: ['free-review'] };
  if (m.stale) {
    const c = m.stale, row = c.staleClaim, gone = row.seatFolderMissing === s.ownerRegisteredPath, lapsed = !gone && c.leaseLapse === true && s.item.leaseUntil <= m.now;
    const expiry = lapsed ? { expiredClaim: { holder: HOLDER, leaseUntil: s.item.leaseUntil, lastActivity: row.lastActivity, observedAt: c.observedAt, leaseEventId: row.leaseEventId },
      reopenFirstRefusal: { builder: HOLDER, until: iso(NOW + Date.parse(s.item.leaseUntil) - Date.parse(s.ownerLastLease.at)) } } : {};
    const record = { holder: HOLDER, lastActivity: row.lastActivity, observedAt: c.observedAt, claimEventId: 50, limitMs: limitOf(c), blocker: row.blocker === true, ...expiry,
      ...(gone ? { seatFolderMissing: SEAT, reason: `registered worktree no longer exists: ${SEAT}; ${note}` } : { reason: note }) };
    return { patch: { status: 'open', owner: null, leaseUntil: null }, events: [release({ staleClaim: record, reason: record.reason, ...expiry })], via: ['release-stale'] };
  }
  const auto = s.lastClaim?.detail.autoNextSnapshot, untouched = s.lastClaim?.by === m.actor && typeof m.worktreeSnapshot?.digest === 'string'
    && m.worktreeSnapshot.head === auto?.head && m.worktreeSnapshot.digest === auto?.digest;
  const patch = { status: 'open', owner: null, leaseUntil: null, ...(m.on ? { after: [...new Set([...s.item.after, ...m.on])] } : {}), ...(m.reason === 'DIAGNOSIS_WRONG' ? { route: 'mid' } : {}) };
  const events = [release({ ...(m.on ? { blockedOn: m.on } : {}), ...(untouched ? { untouchedAutoClaim: true } : {}), ...(note ? { reason: note } : {}) })];
  const via = ['return-claim'], chosen = mine(s, m) && !untouched, route = s.item.route, up = { light: 'mid', mid: 'strong', strong: 'strong' }[route];
  const escalate = (text) => { Object.assign(patch, { route: up, owner: null, leaseUntil: null, status: 'open' }); events.push({ kind: 'escalate', by: 'coordinator', detail: { from: route, to: up, note: text } }); };
  const calibrated = chosen && ['BUDGET', 'INELIGIBLE'].includes(m.reason) && s.actor.route === route;
  if (calibrated) { via.push('route-calibration'); escalate(`${m.actor} released at the ${route} route: ${m.reason}${note ? ` (${note})` : ''}`); }
  const twice = chosen && QUALITY.includes(m.reason) && !m.on?.length, counted = [...x.counted, ...(x.lateInfra ? [] : [{ by: m.actor, code: m.reason, reason: note }])];
  if (twice && counted.length >= 2 && !s.item.holdReason && !(calibrated && route !== 'strong')) {
    const reasons = counted.slice(-2).map(e => `${e.by}: ${e.code}${e.reason ? ` (${e.reason})` : ''}`).join('; ');
    via.push('released-twice');
    if (route !== 'strong') escalate(`Released twice at the ${route} route: ${reasons}`);
    else { Object.assign(patch, { holdReason: `Released twice: ${reasons}`, holdBy: 'coordinator' }); events.push({ kind: 'hold_item', by: 'coordinator', detail: { reason: `Released twice: ${reasons}`, automatic: 'release-twice' } }); }
  }
  return { patch, events, via };
}

const CASES = 15_000;
const results = Array.from({ length: CASES }, (_, seed) => { const { s, m, x } = scenario(seed + 1); return { seed: seed + 1, s, m, x, result: run(s, m) }; });
const ok = results.filter(c => !c.result.refused);

test('moves.release.rows-fire: generated: every guard, outcome and follow-up row of the release table fires on some seeded case [C7,#8264]', () => {
  const fired = new Set(results.flatMap(c => (c.result.refused ? [c.result.refused.row] : c.result.via)));
  const rows = [...TABLE.guards, ...TABLE.outcomes, ...TABLE.followups].map(row => row.id);
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
  assert.deepEqual(Object.keys(ROWS), TABLE.guards.map(row => row.id));
  assert.ok(ok.length > CASES / 5, `only ${ok.length} accepted releases`);
});

test('moves.release.refusal-rows: generated: every release refuses at the guard the restated rules name, writes nothing, and carries that row\'s code and next step [C7,#8264]', () => {
  for (const c of results) {
    const row = firstRefusal(c.s, c.m), { refused } = c.result;
    assert.equal(refused?.row ?? null, row, `seed ${c.seed}`);
    if (!refused) continue;
    assert.ok(!('patch' in c.result) && !('events' in c.result) && refused.message, `seed ${c.seed}`);
    const seats = c.s.io?.sessionSeats ?? [], here = row === 'not-held-elsewhere' ? `release it from that seat's checkout: cd '${SEAT}' && pullboard release ${ID}` : null;
    const next = row === 'joined' && seats.length ? `continue in that seat: cd '/w/it'\\''s' && pullboard next; or give this checkout its own seat: ${JOIN}` : here ?? ROWS[row][1];
    assert.deepEqual([refused.code, refused.next], [ROWS[row][0], next], `seed ${c.seed}`);
    if (row === 'joined') assert.equal(refused.message, seats.length ? `this checkout has no seat, and your session's seats work in their own checkouts: core-9 (core lane) in /w/it's; core-8 (view lane) in /w/b` : `this worktree has not joined a lane; run ${JOIN}`);
    if (row === 'stale-valid') assert.equal(refused.message, staleWhy(c.s, c.m), `seed ${c.seed}`);
  }
});

test('moves.release.accepted-writes: generated: each accepted release writes the patch, events and follow-ups the restated rule gives [C7,#8264]', () => {
  for (const c of ok) assert.deepEqual(c.result, expected(c.s, c.m, c.x), `seed ${c.seed}`);
  for (const via of ['route-calibration', 'released-twice']) assert.ok(ok.filter(c => c.result.via.includes(via)).length > 20, via);
});

test('moves.release.deterministic: generated: the table is deterministic and reads its snapshot without changing it [C7,#8264]', () => {
  for (const c of results.slice(0, 2000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.m);
    assert.deepEqual(runTable(TABLE, RULES, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.m], `seed ${c.seed}`);
  }
});

test('moves.release.fact-breaks: metamorphic: break one fact of an accepted release and it refuses with that fact\'s code [C7,#8264]', () => {
  const breaks = {
    NOT_YOUR_CHECKOUT: (c) => [{ ...c.s, io: { checkoutOwner: 'session-b' } }, c.m], NOT_JOINED: (c) => [{ ...c.s, actor: { ...c.s.actor, joined: false } }, c.m],
    RELEASE_REASON: (c) => [c.s, { ...c.m, reason: 'NOPE' }], NO_ITEM: (c) => [{ ...c.s, item: null }, c.m],
    NOT_YOURS: (c) => [c.s, { ...c.m, actor: c.m.stale ? 'core-2' : 'core-4' }],
  };
  for (const c of ok) {
    for (const [code, apply] of Object.entries(breaks)) {
      const want = code === 'RELEASE_REASON' && c.m.on ? 'USAGE' : code === 'NOT_YOURS' && c.m.reason === 'DIAGNOSIS_WRONG' ? 'DIAGNOSIS_WRONG' : code;
      assert.equal(run(...apply(c)).refused?.code, want, `seed ${c.seed}: breaking ${code}`);
    }
    if (c.m.stale) assert.equal(run({ ...c.s, ownerLastClaimId: 1 }, c.m).refused?.message, WHY.changed, `seed ${c.seed}`);
  }
});

test('moves.release.unrelated-facts: metamorphic: an unrelated item, a stale-only fact on an ordinary release, or another first-refusal builder on a held claim changes no outcome [C7,#8264]', () => {
  for (const c of results.filter(each => each.s.item && each.s.item.status !== 'open').slice(0, 5000)) {
    const same = (s, m) => assert.deepEqual(run(s, m), c.result, `seed ${c.seed}`);
    same({ ...c.s, items: { ...c.s.items, 50: { status: 'withdrawn', after: [99] } } }, c.m);
    same({ ...c.s, firstRefusalBuilder: c.m.actor }, c.m);
    if (!c.m.stale) same({ ...c.s, revision: 9, ownerLastClaimId: 1 }, c.m);
  }
});

test('moves.release.table-inputs: generated: the release engine refuses RELEASE_TABLE_INPUTS without a reason list and a stale-limit rule [C7,#8264]', () => {
  const staleLimits = () => ({ claim: 1, blocker: 1 });
  const boards = [undefined, {}, { reasons: [], staleLimits }, { reasons: 'BLOCKED', staleLimits }, { reasons: KNOWN }, { reasons: KNOWN, staleLimits: 'fn' }];
  for (const board of boards) assert.throws(() => releaseEngine(board), { code: 'RELEASE_TABLE_INPUTS' }, JSON.stringify(board));
  assert.equal(typeof releaseEngine({ reasons: ['BLOCKED'], staleLimits }).table, 'object');
});
