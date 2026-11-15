/** The landing lease queue as one move table: acquire, queue, renew, release, expire-and-reclaim and a corrupt queue, over { generation, holder, line } and the 120 s expiry rule [C7,#8164]. */
import { Refused } from '../../../../kernel/light.js';
import { defineRules } from './rules.js';

/** The moves the lease table knows. `request` is the acquire move; its outcome is an acquire, a reclaim or a place in line. */
export const LEASE_MOVES = Object.freeze(['request', 'renew', 'bind', 'release', 'assert', 'inspect']);

/** Moves that act as the holder and so are refused LAND_LEASE_LOST when the caller is not the live holder. */
const HOLDER_MOVES = ['renew', 'bind', 'assert'];

const LOST = 'this command no longer holds the board landing lease; stop its external work, inspect pullboard resume and adopt only after the holder finishes';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = (value) => Number.isSafeInteger(value);

/**
 * Whether an entry's lease has run out: a modern lineage-bound entry lapses when the coordinator lineage changes, any other at its `until`.
 * Why: one reading of expiry, so reclaim and the holder check cannot disagree.
 */
const lapsed = (s, entry) => (s.modern && entry.lineage !== null ? entry.lineage !== s.lineage : Date.parse(entry.until) <= s.now);

/**
 * The queue after a request: expired entries dropped, the request placed or refreshed, and a free trunk handed to the head of the line.
 * Why: this is the whole admission rule; the rows below only name which outcome it was.
 */
function requested(s, m, { leaseMs }) {
  const { lease } = s;
  const holder = lease.holder && lapsed(s, lease.holder) ? null : lease.holder;
  const line = lease.line.filter(entry => !lapsed(s, entry));
  const old = holder?.token === m.token ? holder : line.find(entry => entry.token === m.token);
  const entry = { token: m.token, branch: m.branch, pid: m.pid, label: `${m.label ?? 'coordinator'} landing ${String(m.token).slice(0, 8)}`,
    lineage: m.lineage ?? null, ...(s.modern ? { machine: m.machine ?? null } : {}), ...(old?.guardianPid ? { guardianPid: old.guardianPid } : {}),
    since: old?.since ?? new Date(s.now).toISOString(), until: new Date(s.now + leaseMs).toISOString() };
  let next = holder;
  let queue = line;
  if (holder?.token === m.token) next = { ...entry, generation: holder.generation };
  else if (old) queue = line.map(queued => (queued.token === m.token ? entry : queued));
  else queue = [...line, entry];
  let generation = lease.generation;
  if (!next && queue.length) {
    generation += 1;
    next = { ...queue[0], generation };
    queue = queue.slice(1);
  }
  return { old, entry, lease: { generation, holder: next, line: queue } };
}

/** The event detail the board writes for a lease move; replay compares it word for word. */
const detail = (lease, m) => ({ kind: 'landing_lease', action: m.name, token: m.token ?? null, holder: lease.holder?.label ?? null, generation: lease.generation, queued: lease.line.length });

/**
 * Snapshot: `{ lease: { generation, holder, line }, now, lineage, modern, shared?, legacyShared?, heartbeat? }`; `now` is epoch milliseconds, `lineage` the coordinator's.
 * `heartbeat` is the holder's local heartbeat entry `{ until }` when the physical board has one.
 * Move: `{ name, token, generation?, branch, pid?, label?, lineage?, machine?, guardianPid? }`.
 * Why: the facts are the landing queue's rules in words, so a refusal and its explanation come from the same row.
 */
const leaseRules = ({ valid, leaseMs }) => {
  const ahead = (s, m) => requested(s, m, { leaseMs });
  const holds = (s, m) => {
    const holder = s.lease.holder;
    if (!holder || holder.token !== m.token || holder.generation !== m.generation || holder.branch !== m.branch) return false;
    const timed = holder.lineage === null || s.heartbeat || s.legacyShared;
    const deadline = s.heartbeat?.until ?? holder.until;
    return !(timed && Date.parse(deadline) <= s.now) && holder.lineage === s.lineage;
  };
  return defineRules({
    knownMove: { says: 'the move is one the landing lease knows', holds: (s, m) => LEASE_MOVES.includes(m.name) },
    intact: { says: 'the queue has a whole generation, a holder at that generation, valid entries and no token twice', holds: (s) => {
      const lease = s.lease;
      if (!isObject(lease) || !whole(lease.generation) || lease.generation < 0 || !Array.isArray(lease.line)) return false;
      if (lease.holder && (!whole(lease.holder.generation) || lease.holder.generation < 1 || lease.holder.generation !== lease.generation)) return false;
      const entries = [lease.holder, ...lease.line].filter(Boolean);
      return entries.every(entry => valid(entry)) && new Set(entries.map(entry => entry.token)).size === entries.length;
    } },
    holder: { says: 'the caller is the live holder: its token, generation and branch name the holder, whose deadline has not passed', holds },
    owning: { says: 'the move is not a renew, bind or assert, or the caller is the live holder', reads: ['holder'], holds: (s, m, fact) => !HOLDER_MOVES.includes(m.name) || fact('holder') },
    holderLapsed: { says: 'a holder exists and its lease has expired', holds: (s) => Boolean(s.lease.holder) && lapsed(s, s.lease.holder) },
    bindable: { says: 'the move is not a bind, or it names a guardian the holder does not already name differently', holds: (s, m) => m.name !== 'bind'
      || (whole(m.guardianPid) && m.guardianPid >= 1 && !(s.lease.holder?.guardianPid && s.lease.holder.guardianPid !== m.guardianPid)) },
    identity: { says: 'the move is not a request, or the token is new or keeps the branch, process and lineage it first asked with', holds: (s, m) => {
      if (m.name !== 'request') return true;
      const old = ahead(s, m).old;
      return !old || (old.branch === m.branch && old.pid === m.pid && old.lineage === (m.lineage ?? null));
    } },
    entryValid: { says: 'the move is not a request, or its entry names a valid trunk and process identity', holds: (s, m) => m.name !== 'request' || valid(ahead(s, m).entry) },
    requesting: { says: 'the move is a request', holds: (s, m) => m.name === 'request' },
    reclaiming: { says: 'a request that meets an expired holder', reads: ['requesting', 'holderLapsed'], holds: (s, m, fact) => fact('requesting') && fact('holderLapsed') },
    acquiring: { says: 'a request that leaves the caller as holder', reads: ['requesting'], holds: (s, m, fact) => fact('requesting') && ahead(s, m).lease.holder?.token === m.token },
    renewing: { says: 'the move is a renew', holds: (s, m) => m.name === 'renew' },
    binding: { says: 'the move is a bind', holds: (s, m) => m.name === 'bind' },
    releasing: { says: 'the move is a release', holds: (s, m) => m.name === 'release' },
    checking: { says: 'the move is an assert or an inspect, which write nothing', holds: (s, m) => m.name === 'assert' || m.name === 'inspect' },
  });
};

/** The queue after a release: the holder leaves only when token and generation both name it, and the token leaves the line. */
const released = (s, m) => ({ ...s.lease, holder: s.lease.holder?.token === m.token && s.lease.holder.generation === m.generation ? null : s.lease.holder, line: s.lease.line.filter(entry => entry.token !== m.token) });

const same = (s) => ({ lease: s.lease });
const refresh = (s, m, leaseMs, more) => ({ lease: { ...s.lease, holder: { ...s.lease.holder, ...more, until: new Date(s.now + leaseMs).toISOString() } } });

/**
 * The lease table: guards in order, one row per move and outcome. A corrupt queue is refused before anything reads it as free.
 * Why: a corrupt record read as an unoccupied trunk would let two landers push at once.
 */
const leaseTable = ({ leaseMs }) => Object.freeze({
  name: 'lease',
  guards: Object.freeze([
    { id: 'known', requires: 'knownMove', code: 'LAND_LEASE_REQUEST', message: (s, m) => `the landing lease has no move ${m.name}`, next: `use one of: ${LEASE_MOVES.join(', ')}` },
    { id: 'corrupt', requires: 'intact', code: 'LAND_LEASE_CORRUPT', message: 'the landing queue is unreadable; restore the board from a consistent export before landing', next: 'restore the board from a consistent export before landing' },
    { id: 'lost', requires: 'owning', code: 'LAND_LEASE_LOST', message: LOST, next: 'run pullboard resume, and adopt only after the holder finishes' },
    { id: 'bind', requires: 'bindable', code: 'LAND_LEASE_REQUEST', message: 'this landing already names its owned guardian; start a new pullboard land command', next: 'start a new pullboard land command' },
    { id: 'entry', requires: 'entryValid', code: 'LAND_LEASE_REQUEST', message: 'a landing request needs its trunk and process identity; run pullboard land', next: 'run pullboard land' },
    { id: 'identity', requires: 'identity', code: 'LAND_LEASE_REQUEST', message: 'this landing identity already belongs to another invocation; start a new pullboard land command', next: 'start a new pullboard land command' },
  ]),
  outcomes: Object.freeze([
    { id: 'reclaim', when: 'reclaiming', patch: (s, m) => ({ lease: requested(s, m, { leaseMs }).lease }), events: (s, m) => [detail(requested(s, m, { leaseMs }).lease, m)] },
    { id: 'acquire', when: 'acquiring', patch: (s, m) => ({ lease: requested(s, m, { leaseMs }).lease }), events: (s, m) => [detail(requested(s, m, { leaseMs }).lease, m)] },
    { id: 'queue', when: 'requesting', patch: (s, m) => ({ lease: requested(s, m, { leaseMs }).lease }), events: (s, m) => [detail(requested(s, m, { leaseMs }).lease, m)] },
    { id: 'renew', when: 'renewing', patch: (s, m) => refresh(s, m, leaseMs, {}), events: (s, m) => [detail(refresh(s, m, leaseMs, {}).lease, m)] },
    { id: 'bind', when: 'binding', patch: (s, m) => refresh(s, m, leaseMs, { guardianPid: m.guardianPid }), events: (s, m) => [detail(refresh(s, m, leaseMs, {}).lease, m)] },
    { id: 'release', when: 'releasing', patch: (s, m) => ({ lease: released(s, m) }), events: (s, m) => [detail(released(s, m), m)] },
    { id: 'check', when: 'checking', patch: same, events: () => [] },
  ]),
});

/**
 * Build the lease's rules and table over the lease length and entry validity, handed in by the caller.
 * Why: moves may not import the store cell, and the 120 s rule and the entry check must stay one source; the store passes its own `LANDING_LEASE_MS` and entry check, so there is no second copy to drift.
 *
 * @param {{ leaseMs: number, valid: (entry: object) => boolean }} lease
 * @returns {{ rules: ReturnType<typeof defineRules>, table: Readonly<object> }}
 */
export function leaseEngine(lease) {
  if (!Number.isFinite(lease?.leaseMs) || lease.leaseMs <= 0 || typeof lease?.valid !== 'function') {
    throw new Refused('LAND_LEASE_RULE', 'the landing lease needs its expiry rule: leaseMs and valid', "pass LANDING_LEASE_MS and the store's entry check");
  }
  return Object.freeze({ rules: leaseRules(lease), table: leaseTable(lease) });
}
