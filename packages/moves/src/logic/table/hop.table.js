/** The gate hop as one fenced backbone row: gate and gate-drive are one kind, one owner, one lease rule, and a write from anyone else is refused [C7,#8068]. */
import { Refused } from '../../../../kernel/light.js';
import { defineRules } from './rules.js';

/** Driver deaths a hop survives; the hop that meets its third death ends, so a crash loop never runs forever. */
export const HOP_ATTEMPT_CAP = 3;

/** The moves the hop table knows. */
export const HOP_MOVES = Object.freeze(['create', 'acquire', 'step', 'finish', 'end']);

/** Moves that write as the owner and so are fenced by owner and epoch. */
const FENCED_MOVES = ['step', 'finish'];

/**
 * Snapshot: `{ item: { status, commit, digest }, hop: null | { state: 'queued'|'driven'|'done'|'ended', owner, epoch, leaseUntil, attempts, commit, digest }, now }`.
 * Move: `{ name, actor, epoch }`; `epoch` is the owner epoch the caller was given when it acquired.
 * Why: the facts are the U145 model's rules in words, and every guard below names one, so the refusal and its explanation cannot drift.
 */
const hopRules = ({ leaseLapsed }) => defineRules({
  knownMove: { says: 'the move is one the hop knows', holds: (s, m) => HOP_MOVES.includes(m.name) },
  fresh: { says: 'no hop exists for this item commit yet', holds: (s) => s.hop === null || s.hop === undefined },
  exists: { says: 'a hop exists', holds: (s) => s.hop !== null && s.hop !== undefined },
  waits: { says: 'the item still waits on this hop: claimed at its commit and digest', holds: (s) => s.item?.status === 'claimed' && (!s.hop || (s.item.commit === s.hop.commit && s.item.digest === s.hop.digest)) },
  open: { says: 'the hop is not over', holds: (s) => s.hop?.state === 'queued' || s.hop?.state === 'driven' },
  queued: { says: 'the hop is queued, with no owner', holds: (s) => s.hop?.state === 'queued' },
  lapsed: { says: 'the hop is driven and its lease has lapsed', holds: (s) => s.hop?.state === 'driven' && leaseLapsed(s.hop.leaseUntil, s.now) },
  acquirable: { says: 'the hop is queued or its lease lapsed', reads: ['queued', 'lapsed'], holds: (s, m, fact) => fact('queued') || fact('lapsed') },
  holder: { says: 'the caller owns the hop at its current owner epoch', holds: (s, m) => s.hop?.state === 'driven' && s.hop.owner === m.actor && s.hop.epoch === m.epoch },
  underCap: { says: 'the hop has a driver death to spare', holds: (s) => (s.hop?.attempts ?? 0) < HOP_ATTEMPT_CAP - 1 },
  itemMoved: { says: 'the item moved off this hop', reads: ['waits'], holds: (s, m, fact) => !fact('waits') },
  startable: { says: 'the move is not a create, or no hop exists yet', reads: ['fresh'], holds: (s, m, fact) => m.name !== 'create' || fact('fresh') },
  creatable: { says: 'the move is not a create, or the item waits', reads: ['waits'], holds: (s, m, fact) => m.name !== 'create' || fact('waits') },
  present: { says: 'the move is a create, or a hop exists', reads: ['exists'], holds: (s, m, fact) => m.name === 'create' || fact('exists') },
  live: { says: 'the move is a create, or the hop is not over', reads: ['open'], holds: (s, m, fact) => m.name === 'create' || fact('open') },
  takeable: { says: 'the move is not an acquire, or the hop is queued or lapsed', reads: ['acquirable'], holds: (s, m, fact) => m.name !== 'acquire' || fact('acquirable') },
  fenced: { says: 'the move is not a step or finish, or its caller owns the hop at the current epoch', reads: ['holder'], holds: (s, m, fact) => !FENCED_MOVES.includes(m.name) || fact('holder') },
  serving: { says: 'the move is not an acquire, step or finish, or the item still waits', reads: ['waits'], holds: (s, m, fact) => !['acquire', ...FENCED_MOVES].includes(m.name) || fact('waits') },
  endable: { says: 'the move is not an end, or the item moved off the hop', reads: ['itemMoved'], holds: (s, m, fact) => m.name !== 'end' || fact('itemMoved') },
  creating: { says: 'the move is a create', reads: ['fresh'], holds: (s, m, fact) => m.name === 'create' && fact('fresh') },
  stepping: { says: 'the move is a step', holds: (s, m) => m.name === 'step' },
  finishing: { says: 'the move is a finish', holds: (s, m) => m.name === 'finish' },
  ending: { says: 'the move is an end', holds: (s, m) => m.name === 'end' },
  captured: { says: 'an acquire of a lapsed hop that has used its driver deaths', reads: ['lapsed', 'underCap'], holds: (s, m, fact) => m.name === 'acquire' && fact('lapsed') && !fact('underCap') },
  taking: { says: 'an acquire of a queued hop', reads: ['queued'], holds: (s, m, fact) => m.name === 'acquire' && fact('queued') },
  retaking: { says: 'an acquire of a lapsed hop with a death to spare', reads: ['lapsed', 'underCap'], holds: (s, m, fact) => m.name === 'acquire' && fact('lapsed') && fact('underCap') },
});

const at = (s, m, more) => ({ hop: { ...s.hop, ...more } });

/**
 * The hop table: guards in order, one row per move. A write from a non-holder or a stale epoch is HOP_FENCED, and an item move ends the hop in its own move.
 * Why: U145's verdict is one fenced row that is the queue, with one liveness rule and reclaim only by acquisition; nothing else wakes or ends a hop.
 */
const hopTable = ({ leaseMs }) => Object.freeze({
  name: 'hop',
  guards: Object.freeze([
    { id: 'known', requires: 'knownMove', code: 'HOP_UNKNOWN_MOVE', message: (s, m) => `the hop has no move ${m.name}`, next: `use one of: ${HOP_MOVES.join(', ')}` },
    { id: 'startable', requires: 'startable', code: 'HOP_EXISTS', message: 'a hop already exists for this item commit', next: 'acquire the existing hop instead of creating another' },
    { id: 'creatable', requires: 'creatable', code: 'HOP_NOT_WAITING', message: 'the item is not claimed at the hop commit and digest', next: 'claim the item, or let the hop end' },
    { id: 'present', requires: 'present', code: 'HOP_MISSING', message: 'no hop exists for this item', next: 'create the hop first' },
    { id: 'live', requires: 'live', code: 'HOP_OVER', message: 'the hop is already done or ended', next: 'nothing to drive; read the item for the result' },
    { id: 'takeable', requires: 'takeable', code: 'HOP_HELD', message: (s) => `the hop is driven by ${s.hop.owner} and its lease has not lapsed`, next: 'wait for the lease to lapse, then acquire' },
    { id: 'fenced', requires: 'fenced', code: 'HOP_FENCED', message: (s, m) => `${m.actor} at epoch ${m.epoch} does not own this hop (owner ${s.hop.owner ?? 'none'} at epoch ${s.hop.epoch})`, next: 'stop driving: another driver owns the hop; acquire it again if it lapses' },
    { id: 'serving', requires: 'serving', code: 'HOP_ITEM_MOVED', message: 'the item no longer waits on this hop', next: 'end the hop with the item move' },
    { id: 'endable', requires: 'endable', code: 'HOP_STILL_WAITS', message: 'the item still waits on this hop', next: 'step or finish the hop; only an item move ends it' },
  ]),
  outcomes: Object.freeze([
    { id: 'create', when: 'creating', patch: (s) => ({ hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: s.item.commit, digest: s.item.digest } }), events: () => [{ kind: 'hop.created' }] },
    { id: 'take', when: 'taking', patch: (s, m) => at(s, m, { state: 'driven', owner: m.actor, epoch: s.hop.epoch + 1, leaseUntil: s.now + leaseMs }), events: (s, m) => [{ kind: 'hop.acquired', owner: m.actor, epoch: s.hop.epoch + 1 }] },
    { id: 'retake', when: 'retaking', patch: (s, m) => at(s, m, { state: 'driven', owner: m.actor, epoch: s.hop.epoch + 1, leaseUntil: s.now + leaseMs, attempts: s.hop.attempts + 1 }), events: (s, m) => [{ kind: 'hop.acquired', owner: m.actor, epoch: s.hop.epoch + 1, lapsedFrom: s.hop.owner }] },
    { id: 'cap', when: 'captured', patch: (s, m) => at(s, m, { state: 'ended', owner: null, epoch: s.hop.epoch + 1, attempts: s.hop.attempts + 1 }), events: (s) => [{ kind: 'hop.capped', attempts: s.hop.attempts + 1 }] },
    { id: 'step', when: 'stepping', patch: (s, m) => at(s, m, { leaseUntil: s.now + leaseMs }), events: (s, m) => [{ kind: 'hop.stepped', owner: m.actor }] },
    { id: 'finish', when: 'finishing', patch: (s, m) => at(s, m, { state: 'done', owner: null, result: m.result ?? null }), events: (s, m) => [{ kind: 'hop.finished', owner: m.actor }] },
    { id: 'end', when: 'ending', patch: (s, m) => at(s, m, { state: 'ended', owner: null, epoch: s.hop.epoch + 1 }), events: () => [{ kind: 'hop.ended' }] },
  ]),
});

/**
 * Build the hop's rules and table over the job store's lease rule, handed in by the caller.
 * Why: moves may not import the jobs cell, and the lease rule must stay one source; the wiring item passes jobs' own `leaseLapsed` and `LEASE_MS`, so there is no second copy to drift.
 *
 * @param {{ leaseMs: number, leaseLapsed: (leaseUntil: number, now: number) => boolean }} lease
 * @returns {{ rules: ReturnType<typeof defineRules>, table: Readonly<object> }}
 */
export function hopEngine(lease) {
  if (!Number.isFinite(lease?.leaseMs) || typeof lease?.leaseLapsed !== 'function') {
    throw new Refused('HOP_LEASE', 'the hop needs the job lease rule: leaseMs and leaseLapsed', "pass LEASE_MS and leaseLapsed from the jobs cell's own rules");
  }
  return Object.freeze({ rules: hopRules(lease), table: hopTable(lease) });
}
