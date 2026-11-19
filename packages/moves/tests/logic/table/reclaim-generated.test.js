/** Tests generated from the reclaim table: every guard and outcome row over thousands of seeded maintenance observations, checked against the rules restated here, and metamorphic breaks that must refuse or must not matter [C7,#8560]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECLAIM_RULES } from '../../../index.js';
import { RECLAIM_TABLE } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';

const ID = 43;
const NOW = '2026-11-15T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const MIN = 60_000;
const ago = (ms) => new Date(NOW_MS - ms).toISOString();
const ahead = (ms) => new Date(NOW_MS + ms).toISOString();
const run = (snapshot, move) => runTable(RECLAIM_TABLE, RECLAIM_RULES, structuredClone(snapshot), structuredClone(move));

/** The limits the move carries: the quiet times that make a claim, review or dependency stale. */
const LIMITS = { claim: 30 * MIN, review: 30 * MIN, dependency: 60 * MIN };
const HANDOFF = { pin: `refs/pullboard/handoffs/${ID}/a`, head: 'ab'.repeat(20), changedFiles: ['a.js'], changedCount: 1 };

/** The quiet an idle claim must reach, in words restated here: a stall 20 minutes, a release 40 (30 when its work is pinned), a dependency its own limit. */
const QUIET = { stall: 20 * MIN, release: 40 * MIN, dependency: LIMITS.dependency };

/** A held item, the seat's last claim, and the move to reclaim it as `idle`; `extra` completes the kind's own captured facts. */
function idle(kind, g) {
  const s = { item: { status: 'claimed', owner: 'w1', after: [], leaseUntil: ahead(MIN) }, ownerLastClaimId: 11, deps: {} };
  const row = { id: ID, actor: 'w1', claimEventId: 11, idle: kind };
  const m = { kind: 'idle', maintainer: 'm1', observedAt: NOW, limits: LIMITS, row };
  if (['stall', 'release', 'dependency'].includes(kind)) {
    if (kind === 'release') s.pinned = g.pick([true, false]);
    const quiet = (kind === 'release' && s.pinned ? 30 * MIN : QUIET[kind]) + g.int(4) * MIN;
    Object.assign(row, { idleMs: quiet, workActivity: ago(quiet) });
    if (kind === 'dependency') Object.assign(s, { waiters: [{ id: 50 }], lastWork: row.workActivity }), Object.assign(row, { dependents: [{ id: 50 }], resourceQuiet: true });
  }
  if (['release', 'progress', 'dependency'].includes(kind)) row.handoff = structuredClone(g.int(2) === 0 ? HANDOFF : { pin: null, unpinned: 'nothing changed', changedFiles: [], changedCount: 0 });
  if (kind === 'progress') {
    Object.assign(row, { commitAt: g.pick([null, ago(31 * MIN + g.int(100) * MIN)]), progress: { trigger: 'a red landing', notes: g.pick([[], ['n1', 'n2']]) } });
    s.progressNow = structuredClone(row.progress);
  }
  if (kind === 'seat-gone') row.deadSeat = g.pick([{ worktreeMissing: true, heartbeatAt: ago(MIN) }, { worktreeMissing: false, heartbeatAt: ago(3 * MIN + g.int(60) * MIN) }]);
  if (kind === 'seat-gone') Object.assign(row.deadSeat, { observedAt: NOW, quietMs: 120_000 });
  if (kind === 'waiting') Object.assign(row, { waitingOn: [5] }), Object.assign(s.item, { after: [5, 6] }), Object.assign(s.deps, { 5: { status: 'open', merged: false } });
  return { s, m, outcome: kind === 'stall' ? 'stall-notice' : 'reclaim-idle' };
}

/** A lapsed claim: its lease was granted, ran out, and the claim has been quiet past the stale interval since. */
function lapsed(g) {
  const start = ago(4 * 3_600_000), until = ago(3 * 3_600_000), leaseMs = 3_600_000;
  const s = { item: { status: 'claimed', owner: 'w1', leaseUntil: until }, ownerLastLease: { id: 21, at: start, leaseUntil: until } };
  const m = { kind: 'lapsed-claim', maintainer: 'm1', observedAt: NOW, now: NOW, limits: LIMITS,
    row: { id: ID, actor: 'w1', leaseUntil: until, leaseEventId: 21, leaseStartedAt: start, leaseMs, lastActivity: ago(LIMITS.claim + g.int(90) * MIN), limitMs: LIMITS.claim, evidence: { complete: true } } };
  return { s, m, outcome: 'expire-lapsed-claim' };
}

/** A submission whose reviewer reserved it and has been idle past the review limit. */
function review(g) {
  const reservedAt = ago(5 * 3_600_000);
  const s = { item: { status: 'submitted', reviewer: 'rv1', commit: 'c1', reviewUntil: ahead(MIN) }, reserve: { id: 31, at: reservedAt }, lastSubmitId: 32 };
  const m = { kind: 'review-idle', maintainer: 'm1', observedAt: NOW, limits: LIMITS,
    row: { id: ID, reviewer: 'rv1', commit: 'c1', reviewUntil: s.item.reviewUntil, reserveEventId: 31, reservedAt, sourceSubmitEventId: 32, lastActivity: ago(LIMITS.review + g.int(90) * MIN), limitMs: LIMITS.review, evidence: { complete: true } } };
  return { s, m, outcome: 'free-idle-review' };
}

/** A review whose reservation lease lapsed while its reviewer still held it, seen at some earlier time or not. */
function reviewLapse(g) {
  const s = { item: { status: 'submitted', reviewer: 'rv1', reviewUntil: ahead(MIN + g.int(60) * MIN) } };
  const m = { kind: 'review-lapse', maintainer: 'm1', now: NOW, seenAt: g.pick([undefined, null, ago(g.int(50) * MIN)]), lapse: { reviewer: 'rv1', lapsedMs: (1 + g.int(40)) * MIN } };
  return { s, m, outcome: 'free-lapsed-review' };
}

const IDLE_KINDS = ['stall', 'release', 'progress', 'seat-gone', 'waiting', 'dependency'];

/** Each way to spoil an accepted case, by the kind of observation it spoils: what to change, and the row and code that must then refuse. Facts only a kind has are listed under that kind. */
const BREAKS = {
  idle: [
    ['owner moved', c => { c.s.item.owner = 'w2'; }, 'idle-current', 'STALE_STATE_CHANGED'],
    ['claim moved', c => { c.s.ownerLastClaimId = 99; }, 'idle-current', 'STALE_STATE_CHANGED'],
    ['maintainer holds it', c => { c.m.maintainer = 'w1'; }, 'idle-current', 'STALE_STATE_CHANGED'],
    ['item released', c => { c.s.item.status = 'open'; }, 'idle-current', 'STALE_STATE_CHANGED'],
    ['unknown idle kind', c => { c.m.row.idle = 'nap'; }, 'idle-proven', 'BAD_STALE_STATE'],
  ],
  quiet: [
    ['not quiet long enough', c => { c.m.row.idleMs -= 5 * MIN; c.m.row.workActivity = ago(c.m.row.idleMs); if (c.s.lastWork) c.s.lastWork = c.m.row.workActivity; }, 'idle-proven', 'BAD_STALE_STATE'],
    ['idle time misstated', c => { c.m.row.idleMs += 1; }, 'idle-proven', 'BAD_STALE_STATE'],
    ['activity in the future', c => { c.m.row.workActivity = ahead(MIN); c.m.row.idleMs = -MIN; }, 'idle-proven', 'BAD_STALE_STATE'],
  ],
  handoff: [
    ['hand-off names nothing', c => { c.m.row.handoff = { pin: null, unpinned: '', changedFiles: [], changedCount: 0 }; }, 'idle-proven', 'BAD_STALE_STATE'],
    ['hand-off pins another item', c => { c.m.row.handoff = { ...HANDOFF, pin: 'refs/pullboard/handoffs/1/a' }; }, 'idle-proven', 'BAD_STALE_STATE'],
  ],
  redReturn: [['red return holds the lease', c => { c.s.redReturnLease = true; }, 'idle-current', 'STALE_STATE_CHANGED']],
  gate: [['gate not settled', c => { c.s.gateInFlight = true; }, 'idle-current', 'STALE_STATE_CHANGED']],
  progress: [
    ['committed just now', c => { c.m.row.commitAt = ago(MIN); }, 'idle-proven', 'BAD_STALE_STATE'],
    ['progress moved on', c => { c.s.progressNow = { trigger: 'other', notes: [] }; }, 'idle-proven', 'BAD_STALE_STATE'],
    ['no trigger now', c => { c.s.progressNow = { trigger: '', notes: [] }; c.m.row.progress = { trigger: '', notes: [] }; }, 'idle-proven', 'BAD_STALE_STATE'],
  ],
  'seat-gone': [
    ['seat alive', c => { c.m.row.deadSeat = { worktreeMissing: false, heartbeatAt: ago(MIN), observedAt: NOW, quietMs: 120_000 }; }, 'idle-proven', 'BAD_STALE_STATE'],
    ['seat seen another time', c => { c.m.row.deadSeat.observedAt = ago(MIN); }, 'idle-proven', 'BAD_STALE_STATE'],
    ['quiet limit misstated', c => { c.m.row.deadSeat.quietMs = 60_000; }, 'idle-proven', 'BAD_STALE_STATE'],
  ],
  waiting: [
    ['dependency landed', c => { c.s.deps[5].merged = true; }, 'idle-current', 'STALE_STATE_CHANGED'],
    ['dependency withdrawn', c => { c.s.deps[5].status = 'withdrawn'; }, 'idle-current', 'STALE_STATE_CHANGED'],
    ['no longer waits', c => { c.s.item.after = [6]; }, 'idle-current', 'STALE_STATE_CHANGED'],
    ['waits on nothing', c => { c.m.row.waitingOn = []; }, 'idle-proven', 'BAD_STALE_STATE'],
  ],
  dependency: [
    ['dependents moved', c => { c.s.waiters = []; }, 'idle-current', 'STALE_STATE_CHANGED'],
    ['resource busy', c => { c.m.row.resourceQuiet = false; }, 'idle-proven', 'BAD_STALE_STATE'],
    ['work since', c => { c.s.lastWork = ago(MIN); }, 'idle-proven', 'BAD_STALE_STATE'],
  ],
  lapsed: [
    ['lease changed', c => { c.s.item.leaseUntil = ago(2 * 3_600_000); }, 'lapse-current', 'STALE_STATE_CHANGED'],
    ['lease event moved', c => { c.s.ownerLastLease.id = 98; }, 'lapse-current', 'STALE_STATE_CHANGED'],
    ['no lease recorded', c => { c.s.ownerLastLease = undefined; }, 'lapse-current', 'STALE_STATE_CHANGED'],
    ['owner moved', c => { c.s.item.owner = 'w2'; }, 'lapse-current', 'STALE_STATE_CHANGED'],
    ['lease length misstated', c => { c.m.row.leaseMs += 1; }, 'lapse-current', 'STALE_STATE_CHANGED'],
    ['observations incomplete', c => { c.m.row.evidence = { complete: false }; }, 'lapse-proven', 'BAD_STALE_STATE'],
    ['limit misstated', c => { c.m.row.limitMs = 1; }, 'lapse-proven', 'BAD_STALE_STATE'],
    ['active a moment ago', c => { c.m.row.lastActivity = ago(MIN); }, 'lapse-proven', 'BAD_STALE_STATE'],
    ['gate not settled', c => { c.s.gateInFlight = true; }, 'lapse-current', 'STALE_STATE_CHANGED'],
  ],
  review: [
    ['commit moved', c => { c.s.item.commit = 'c9'; }, 'review-current', 'STALE_STATE_CHANGED'],
    ['reviewer moved', c => { c.s.item.reviewer = 'rv2'; }, 'review-current', 'STALE_STATE_CHANGED'],
    ['reservation moved', c => { c.s.reserve.id = 99; }, 'review-current', 'STALE_STATE_CHANGED'],
    ['resubmitted', c => { c.s.lastSubmitId = 99; }, 'review-current', 'STALE_STATE_CHANGED'],
    ['not submitted', c => { c.s.item.status = 'claimed'; }, 'review-current', 'STALE_STATE_CHANGED'],
    ['observations incomplete', c => { c.m.row.evidence = { complete: false }; }, 'review-proven', 'BAD_STALE_STATE'],
    ['active a moment ago', c => { c.m.row.lastActivity = ago(MIN); }, 'review-proven', 'BAD_STALE_STATE'],
    ['limit misstated', c => { c.m.row.limitMs = 1; }, 'review-proven', 'BAD_STALE_STATE'],
  ],
  'review-lapse': [
    ['reviewer moved', c => { c.s.item.reviewer = 'rv2'; }, 'review-lapse-live', 'SKIP'],
    ['lease runs again', c => { c.s.item.reviewUntil = ahead(MIN); c.m.now = ahead(2 * MIN); }, 'review-lapse-live', 'SKIP'],
    ['not submitted', c => { c.s.item.status = 'open'; }, 'review-lapse-live', 'SKIP'],
  ],
};

/** The break groups an accepted case answers to. */
const groupsOf = (c, label) => {
  if (c.m.kind === 'lapsed-claim') return ['lapsed'];
  if (c.m.kind === 'review-idle') return ['review'];
  if (c.m.kind === 'review-lapse') return ['review-lapse'];
  const quiet = ['stall', 'release', 'dependency'].includes(label);
  return ['idle', 'gate', ...(quiet ? ['quiet'] : []), ...(['release', 'progress', 'dependency'].includes(label) ? ['handoff'] : []), ...(['stall', 'release', 'progress', 'dependency'].includes(label) ? ['redReturn'] : []), ...(BREAKS[label] ? [label] : [])];
};

/** One seeded observation, accepted or with one fact spoiled: a stall, idle claim of every kind, lapsed claim, idle review or lapsed review. */
function scenario(seed) {
  const g = seeded(seed);
  const label = g.pick([...IDLE_KINDS, ...IDLE_KINDS, 'lapsed', 'review', 'review-lapse']);
  const made = label === 'lapsed' ? lapsed(g) : label === 'review' ? review(g) : label === 'review-lapse' ? reviewLapse(g) : idle(label, g);
  const c = { ...made, label };
  const spoilable = groupsOf(c, label).flatMap(group => BREAKS[group]);
  const spoil = g.int(3) === 0 ? g.pick(spoilable) : undefined;
  const base = structuredClone({ s: c.s, m: c.m });
  if (spoil) spoil[1](c);
  return { seed, label, outcome: c.outcome, spoil, base, s: c.s, m: c.m };
}

const CASES = 20_000;
const results = Array.from({ length: CASES }, (_, seed) => {
  const c = scenario(seed + 1);
  return { ...c, result: run(c.s, c.m) };
});
const ok = results.filter(c => !c.result.refused);
const accepted = results.filter(c => !c.spoil);

test('moves.reclaim.rows-fire: generated: every guard and outcome row of the reclaim table fires on some seeded case [C7,#8560]', () => {
  const fired = new Set(results.map(c => (c.result.refused ? c.result.refused.row : c.result.via[0])));
  const rows = [...RECLAIM_TABLE.guards.map(row => row.id), ...RECLAIM_TABLE.outcomes.map(row => row.id)];
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
  assert.ok(ok.length > CASES / 2, `only ${ok.length} accepted observations`);
});

test('moves.reclaim.refusal-codes: generated: each case is refused at the row and code its spoiled fact names, or takes the outcome its kind names when nothing is spoiled [C7,#8560]', () => {
  for (const c of results) {
    if (c.spoil) assert.deepEqual([c.result.refused?.row, c.result.refused?.code], [c.spoil[2], c.spoil[3]], `seed ${c.seed}: ${c.label}: ${c.spoil[0]}`);
    else assert.deepEqual([c.result.refused, c.result.via], [undefined, [c.outcome]], `seed ${c.seed}: ${c.label}`);
  }
});

test('moves.reclaim.refusal-writes-nothing: generated: a refusal writes nothing and names a message and a next step [C7,#8560]', () => {
  for (const c of results.filter(each => each.result.refused)) {
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}`);
    assert.ok(c.result.refused.message && c.result.refused.next, `seed ${c.seed}`);
  }
});

test('moves.reclaim.frees-the-work: generated: an accepted reclaim frees the claim or the review its row names and a stall only records a notice [C7,#8560]', () => {
  const FREE = { status: 'open', owner: null, leaseUntil: null };
  for (const c of accepted) {
    const { patch, events, via } = c.result;
    if (via[0] === 'stall-notice') assert.deepEqual([patch, events.map(e => e.kind)], [{}, ['claim_stalled']], `seed ${c.seed}`);
    else if (['reclaim-idle', 'expire-lapsed-claim'].includes(via[0])) assert.deepEqual(patch, FREE, `seed ${c.seed}`);
    else assert.deepEqual(patch, { reviewer: null, reviewUntil: null }, `seed ${c.seed}`);
    assert.ok(events.length >= 1 && events.every(e => e.by !== undefined), `seed ${c.seed}`);
  }
});

test('moves.reclaim.release-words: generated: each reclaim records one release by the maintainer whose reason and code are the ones its kind names [C7,#8560]', () => {
  for (const c of accepted.filter(each => each.label !== 'review-lapse' && each.label !== 'stall')) {
    const release = c.result.events.at(-1), { detail } = release;
    assert.equal(release.kind, 'release', `seed ${c.seed}`);
    assert.equal(release.by, 'm1', `seed ${c.seed}`);
    assert.equal(detail.reasonCode, c.label === 'waiting' ? 'BLOCKED' : 'OTHER', `seed ${c.seed}`);
    if (c.label === 'lapsed') assert.deepEqual([detail.reason, detail.expiredClaim.holder, detail.reopenFirstRefusal], ['Lapsed claim idle past its stale interval.', 'w1', { builder: 'w1', until: ahead(c.m.row.leaseMs) }], `seed ${c.seed}`);
    else if (c.label === 'review') assert.deepEqual([detail.review, detail.stale.reviewer, detail.reason.startsWith('Review idle for 30 minutes')], [true, 'rv1', true], `seed ${c.seed}`);
    else if (c.label === 'waiting') assert.deepEqual([detail.reason, detail.idleClaim.waitingOn], ['Waiting on #5, which has not landed; the item returns to the queue when it lands.', [5]], `seed ${c.seed}`);
    else if (c.label === 'seat-gone') assert.deepEqual([detail.reason, detail.reclaim.seat, detail.reclaim.worktreeMissing], ['Seat w1 has no heartbeat for two minutes or its worktree is gone; claim returned to the queue.', 'w1', c.m.row.deadSeat.worktreeMissing], `seed ${c.seed}`);
    else assert.deepEqual([detail.idleClaim.kind, detail.idleClaim.holder, detail.idleClaim.handoff], [c.label, 'w1', c.m.row.handoff], `seed ${c.seed}`);
    assert.ok(detail.reason.length > 20, `seed ${c.seed}`);
  }
});

test('moves.reclaim.progress-window: generated: a progress return keeps its notes as a fact and offers the holder two hours of first refusal, and no other reclaim does [C7,#8560]', () => {
  for (const c of accepted.filter(each => each.label !== 'review-lapse' && each.label !== 'stall')) {
    const names = c.result.events.map(e => e.kind), release = c.result.events.at(-1);
    if (c.label === 'progress') {
      assert.deepEqual(names, ['fact', 'release'], `seed ${c.seed}`);
      assert.equal(c.result.events[0].detail.id, `progress-return-${ID}-11`, `seed ${c.seed}`);
      assert.deepEqual(release.detail.reopenFirstRefusal, { builder: 'w1', otherSeatFirst: true, until: ahead(2 * 3_600_000) }, `seed ${c.seed}`);
    } else assert.equal(names.includes('fact'), false, `seed ${c.seed}`);
    if (c.label !== 'progress' && c.label !== 'lapsed') assert.equal('reopenFirstRefusal' in release.detail, false, `seed ${c.seed}: ${c.label}`);
  }
});

test('moves.reclaim.lapsed-review-words: generated: a lapsed review is freed by the coordinator and says how long it was silent, counted from when it was first seen or else from its lapse [C7,#8560]', () => {
  const lapses = accepted.filter(each => each.label === 'review-lapse');
  assert.ok(lapses.length > 200, `only ${lapses.length} lapsed reviews`);
  for (const c of lapses) {
    const [event] = c.result.events, silent = c.m.seenAt ? NOW_MS - Date.parse(c.m.seenAt) : c.m.lapse.lapsedMs;
    assert.deepEqual([event.by, event.detail.review, event.detail.reason, event.detail.lapsed], ['coordinator', true, `Review silent for ${Math.round(silent / MIN)} minutes; its reservation lease lapsed.`, c.m.lapse], `seed ${c.seed}`);
  }
});

test('moves.reclaim.deterministic: generated: the table is deterministic and reads its snapshot without changing it [C7,#8560]', () => {
  for (const c of results.slice(0, 2000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.m);
    assert.deepEqual(runTable(RECLAIM_TABLE, RECLAIM_RULES, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.m], `seed ${c.seed}`);
  }
});

test('moves.reclaim.spoiled-fact: metamorphic: spoil any one captured fact of an accepted observation and it is refused at the row and code that fact names [C7,#8560]', () => {
  assert.ok(accepted.length > 2000, `only ${accepted.length} unspoiled cases`);
  for (const c of accepted) {
    for (const group of groupsOf({ m: c.m }, c.label)) for (const [name, spoil, row, code] of BREAKS[group]) {
      const copy = structuredClone(c.base);
      spoil(copy);
      const refused = run(copy.s, copy.m).refused;
      assert.deepEqual([refused?.row, refused?.code], [row, code], `seed ${c.seed}: ${c.label}: ${name}`);
    }
  }
});

test('moves.reclaim.gate-in-flight-keeps: clause 1: for every idle kind and a lapsed claim, an accepted observation whose snapshot says gateInFlight true is refused STALE_STATE_CHANGED at idle-current or lapse-current and decides no events [C7,#10934]', () => {
  const held = accepted.filter(c => c.m.kind === 'idle' || c.m.kind === 'lapsed-claim').slice(0, 400);
  assert.deepEqual([...new Set(held.map(c => c.label))].sort(), [...IDLE_KINDS, 'lapsed'].sort(), 'every idle kind and a lapsed claim are covered');
  for (const [seed, c] of held.entries()) {
    const decided = run({ ...structuredClone(c.base.s), gateInFlight: true }, c.base.m);
    const row = c.m.kind === 'idle' ? 'idle-current' : 'lapse-current';
    assert.deepEqual([decided.refused?.row, decided.refused?.code], [row, 'STALE_STATE_CHANGED'], `case ${seed} (${c.label})`);
    assert.ok(!('events' in decided) && !('patch' in decided), `case ${seed} (${c.label}) decides no events`);
  }
});

test('moves.reclaim.gate-settled-decides: clause 2: the same observations with gateInFlight false or absent take exactly the outcome and events they take today [C7,#10934]', () => {
  for (const c of accepted.filter(c => c.m.kind === 'idle' || c.m.kind === 'lapsed-claim').slice(0, 400)) {
    const today = run(c.base.s, c.base.m);
    assert.equal(today.refused, undefined, `${c.label} is accepted`);
    assert.deepEqual(run({ ...structuredClone(c.base.s), gateInFlight: false }, c.base.m), today, `${c.label}: false decides as absent`);
  }
});
