/** The relay outbox as one move table: every state is a row with its legal moves or an explicit refusal and next step, so a half-finished rebuild is a legal state with a recovery [C7,#6729,#6728]. */
import { defineRules } from './rules.js';

/** The states an outbox is in, in the order a move travels through them; the last three are the rebuild's own journal. */
export const OUTBOX_STATES = Object.freeze(['none', 'queued', 'sent', 'acknowledged', 'parked', 'undone', 'applied', 'remade']);

/** The moves the outbox table knows. */
export const OUTBOX_MOVES = Object.freeze(['queue', 'send', 'acknowledge', 'park', 'recover', 'takeBack', 'apply', 'remake', 'write', 'resume', 'fallback']);

/**
 * Which moves are legal from each state; a move not listed is refused with the legal ones named.
 * Why: this is the table the person reads. `undone`, `applied` and `remade` are steps of one rebuild, journaled so a stop at any of them has one way forward: resume.
 */
export const OUTBOX_LEGAL = Object.freeze({
  none: ['queue'],
  queued: ['queue', 'send', 'park', 'takeBack', 'resume', 'fallback'],
  sent: ['queue', 'send', 'acknowledge', 'park', 'takeBack', 'resume', 'fallback'],
  acknowledged: ['queue', 'send', 'acknowledge', 'park', 'takeBack', 'resume', 'fallback'],
  parked: ['queue', 'recover', 'takeBack', 'resume', 'fallback'],
  undone: ['apply', 'resume'],
  applied: ['remake', 'write', 'resume'],
  remade: ['write', 'resume'],
});

/** The state each rebuild step leaves its resume to run next; a stop in a state is finished by running that step. */
const RESUME_AS = Object.freeze({ undone: 'applied', applied: 'remade', remade: 'none' });

/**
 * Snapshot: `{ outbox: { state, baseSequence, moves, sent, receipted, parked, remade }, board: { sequence }, relay?: { checkpoint } }`.
 * `moves` counts the queued tail; `sent` and `receipted` count its prefix the relay took and acknowledged; `board.sequence` is the relay sequence the board has applied.
 * Move: `{ name, count?, sequence?, checkpoint? }`.
 */
export const OUTBOX_RULES = defineRules({
  knownMove: { says: 'the move is one the outbox knows', holds: (s, m) => OUTBOX_MOVES.includes(m.name) },
  stateKnown: { says: 'the outbox is in a state the table lists', holds: (s) => OUTBOX_STATES.includes(s.outbox?.state) },
  legalFromState: { says: 'the outbox state lists this move as legal', holds: (s, m) => OUTBOX_LEGAL[s.outbox?.state]?.includes(m.name) === true },
  behind: { says: 'the board has applied relay sequence beyond the outbox base, so acknowledged moves are applied and the base is stale', holds: (s) => s.outbox?.state !== 'none' && s.board.sequence > s.outbox.baseSequence },
  rebuilding: { says: 'a rebuild is part way through', holds: (s) => ['undone', 'applied', 'remade'].includes(s.outbox?.state) },
  stranded: { says: 'the outbox is behind its receipts, or a rebuild stopped part way', reads: ['behind', 'rebuilding'], holds: (s, m, fact) => fact('behind') || fact('rebuilding') },
  takeable: { says: 'the move is not a take-back, or the board still sits at the outbox base', reads: ['behind'], holds: (s, m, fact) => m.name !== 'takeBack' || !fact('behind') },
  resumable: { says: 'the move is not a resume, or the outbox is stranded', reads: ['stranded'], holds: (s, m, fact) => m.name !== 'resume' || fact('stranded') },
  fallbackable: { says: 'the move is not a checkpoint fallback, or the checkpoint is at or past the outbox base', holds: (s, m) => m.name !== 'fallback' || (Number.isSafeInteger(m.checkpoint) && m.checkpoint >= s.outbox.baseSequence) },
  ackable: { says: 'the move is not an acknowledge, or the relay holds that many sent moves', holds: (s, m) => m.name !== 'acknowledge' || (s.outbox.receipted + (m.count ?? 1) <= s.outbox.sent) },
  sendable: { says: 'the move is not a send, or that many queued moves are left to send', holds: (s, m) => m.name !== 'send' || (s.outbox.sent + (m.count ?? 1) <= s.outbox.moves - s.outbox.parked) },
  parkable: { says: 'the move is not a park, or an unparked move is left to park', holds: (s, m) => m.name !== 'park' || (s.outbox.parked < s.outbox.moves) },
  writable: { says: 'the move is not a write, or every tail move not acknowledged has been made again', holds: (s, m) => m.name !== 'write' || (s.outbox.remade ?? 0) >= s.outbox.moves - s.outbox.receipted },
  remakable: { says: 'the move is not a remake, or a tail move is left to make again', holds: (s, m) => m.name !== 'remake' || (s.outbox.remade ?? 0) < s.outbox.moves - s.outbox.receipted },
  queueing: { says: 'the move is a queue', holds: (s, m) => m.name === 'queue' },
  taking: { says: 'the move is a take-back', holds: (s, m) => m.name === 'takeBack' },
  resuming: { says: 'the move is a resume', holds: (s, m) => m.name === 'resume' },
  falling: { says: 'the move is a checkpoint fallback', holds: (s, m) => m.name === 'fallback' },
  applying: { says: 'the move is the apply step', holds: (s, m) => m.name === 'apply' },
  remaking: { says: 'the move is a remake', holds: (s, m) => m.name === 'remake' },
  writing: { says: 'the move is the write step', holds: (s, m) => m.name === 'write' },
  parking: { says: 'the move is a park', holds: (s, m) => m.name === 'park' },
  recovering: { says: 'the move is a recover', holds: (s, m) => m.name === 'recover' },
  sending: { says: 'the move is a send', holds: (s, m) => m.name === 'send' },
  acknowledging: { says: 'the move is an acknowledge', holds: (s, m) => m.name === 'acknowledge' },
});

const legalWords = (s) => OUTBOX_LEGAL[s.outbox?.state]?.join(', ') ?? 'none';
const at = (s, more) => ({ outbox: { ...s.outbox, ...more } });

/**
 * The outbox table: guards in order, one outcome per move. An outbox behind its receipts is not refused; resume reconciles it from them.
 * Why: GitHub #15 stranded a user in a state no code had a name for (acknowledged prefix applied, outbox base behind it); here that state is `stranded`, and its one way forward is `resume`.
 */
export const OUTBOX_TABLE = Object.freeze({
  name: 'outbox',
  guards: Object.freeze([
    { id: 'known', requires: 'knownMove', code: 'OUTBOX_UNKNOWN_MOVE', message: (s, m) => `the outbox has no move ${m.name}`, next: `use one of: ${OUTBOX_MOVES.join(', ')}` },
    { id: 'state', requires: 'stateKnown', code: 'OUTBOX_UNKNOWN_STATE', message: (s) => `the outbox state ${s.outbox?.state} is not one the table lists`, next: `keep the outbox file and ask for help; the states are ${OUTBOX_STATES.join(', ')}` },
    { id: 'legal', requires: 'legalFromState', code: 'OUTBOX_ILLEGAL_MOVE', message: (s, m) => `an outbox that is ${s.outbox.state} cannot ${m.name}`, next: (s) => `from ${s.outbox.state} the legal moves are: ${legalWords(s)}` },
    { id: 'behind', requires: 'takeable', code: 'OUTBOX_BEHIND', message: (s) => `the board has applied relay sequence ${s.board.sequence} but the outbox base is ${s.outbox.baseSequence}; the acknowledged moves are already applied`, next: 'resume the outbox from its receipts; do not take its moves back again' },
    { id: 'strandable', requires: 'resumable', code: 'OUTBOX_NOT_STRANDED', message: 'the outbox is not part way through a rebuild and not behind its receipts', next: 'nothing to resume; send or rebuild as usual' },
    { id: 'checkpoint', requires: 'fallbackable', code: 'RELAY_OUTBOX', message: (s, m) => `the relay checkpoint (sequence ${m.checkpoint ?? 'unknown'}) is older than the board the queued moves sit on (sequence ${s.outbox.baseSequence})`, next: 'keep the board; resume from the receipts, or ask the person to publish a newer checkpoint' },
    { id: 'acknowledged', requires: 'ackable', code: 'OUTBOX_ACK_UNSENT', message: 'the relay acknowledged moves this machine has not sent', next: 'read the relay prefix again; acknowledge only moves already sent' },
    { id: 'sendable', requires: 'sendable', code: 'OUTBOX_NOTHING_TO_SEND', message: 'no unparked queued move is left to send', next: 'wait for acknowledgements, or recover a parked move' },
    { id: 'parkable', requires: 'parkable', code: 'OUTBOX_NOTHING_TO_PARK', message: 'every queued move is already parked', next: 'recover a parked move, or read the refusals' },
    { id: 'remakable', requires: 'remakable', code: 'OUTBOX_NOTHING_TO_REMAKE', message: 'every waiting move is already made again', next: 'write the new outbox' },
    { id: 'writable', requires: 'writable', code: 'OUTBOX_TAIL_UNMADE', message: 'a waiting move has not been made again on the board', next: 'remake the rest of the tail, in order, before writing the outbox' },
  ]),
  outcomes: Object.freeze([
    { id: 'queue', when: 'queueing', patch: (s) => at(s, { state: ['none', 'parked'].includes(s.outbox.state) ? 'queued' : s.outbox.state, moves: s.outbox.moves + 1 }), events: () => [{ kind: 'outbox.queued' }] },
    { id: 'send', when: 'sending', patch: (s, m) => at(s, { state: 'sent', sent: s.outbox.sent + (m.count ?? 1) }), events: (s, m) => [{ kind: 'outbox.sent', count: m.count ?? 1 }] },
    { id: 'acknowledge', when: 'acknowledging', patch: (s, m) => at(s, { state: 'acknowledged', receipted: s.outbox.receipted + (m.count ?? 1) }), events: (s, m) => [{ kind: 'outbox.acknowledged', count: m.count ?? 1 }] },
    { id: 'park', when: 'parking', patch: (s) => at(s, { state: s.outbox.parked + 1 === s.outbox.moves ? 'parked' : s.outbox.state, parked: s.outbox.parked + 1 }), events: () => [{ kind: 'outbox.parked' }] },
    { id: 'recover', when: 'recovering', patch: (s) => at(s, { state: 'queued', parked: 0 }), events: () => [{ kind: 'outbox.recovered' }] },
    { id: 'take', when: 'taking', patch: (s) => at(s, { state: 'undone', remade: 0 }), events: () => [{ kind: 'outbox.taken-back' }] },
    { id: 'apply', when: 'applying', patch: (s, m) => applied(s, m.receipted ?? s.outbox.receipted), events: (s, m) => [{ kind: 'outbox.applied', sequence: m.sequence }] },
    { id: 'remake', when: 'remaking', patch: (s) => at(s, { state: (s.outbox.remade ?? 0) + 1 >= s.outbox.moves - s.outbox.receipted ? 'remade' : 'applied', remade: (s.outbox.remade ?? 0) + 1 }), events: () => [{ kind: 'outbox.remade' }] },
    { id: 'write', when: 'writing', patch: (s) => settled(s), events: () => [{ kind: 'outbox.written' }] },
    { id: 'resume', when: 'resuming', patch: (s) => resumed(s), events: (s) => [{ kind: 'outbox.resumed', from: s.outbox.state }] },
    { id: 'fallback', when: 'falling', patch: (s) => at(s, { state: 'applied', remade: 0, receipted: s.outbox.receipted }), events: (s, m) => [{ kind: 'outbox.fell-back', checkpoint: m.checkpoint }] },
  ]),
});

/** After the relay's records are applied: with every tail move acknowledged nothing is left to make again, so the rebuild goes straight to its write. */
function applied(s, receipted) {
  return at(s, { state: s.outbox.moves - receipted > 0 ? 'applied' : 'remade', receipted, remade: 0 });
}

/** The outbox after its write: the base is the board's sequence, the tail is what the relay has not acknowledged, and an empty tail leaves no outbox. */
function settled(s) {
  const moves = s.outbox.moves - s.outbox.receipted;
  const base = { baseSequence: s.board.sequence, moves, sent: 0, receipted: 0, parked: 0, remade: 0 };
  return at(s, moves > 0 ? { ...base, state: 'queued' } : { ...base, state: 'none' });
}

/**
 * What a resume does from where the outbox stopped: it takes the next step of the rebuild the journal names; an outbox that is behind its receipts but
 * has no journal is reconciled as if applied, so its receipted moves leave the tail once and the rest are made again.
 */
function resumed(s) {
  const next = RESUME_AS[s.outbox.state];
  if (next === 'none') return settled(s);
  if (next === 'remade') return at(s, { state: 'remade', remade: s.outbox.moves - s.outbox.receipted });
  if (next) return applied(s, s.outbox.receipted);
  return at(s, { state: 'applied', remade: 0 });
}
