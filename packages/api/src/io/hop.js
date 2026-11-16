/** A pulled gate job's fenced hop: the runner that claims an item's gate job owns its gate_hop row, through the hop table and the store's compare-and-set [C7,#8352]. */
import { Refused } from '../../../kernel/index.js';
import { gateHopMove } from '../../../store/index.js';
import { ensureGateHopTable } from '../../../store/index.js';
import { readGateHop } from '../../../store/index.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { leaseLapsed } from '../../../jobs/index.js';

/** The hop table the serving app provides: given a lease length, the table's answer for a snapshot and a move. Why provided: the API cell may not import the moves cell. */
let hopTable = null;

/**
 * The hop table at a lease length, built from the moves cell's hop engine over the jobs cell's own lease rule.
 * Why the engine is passed in: the API cell may not import the moves cell, so the app hands it over and the lease rule stays here.
 *
 * @param {{ hopEngine: Function, runTable: Function }} moves
 * @returns {(leaseMs: number) => (snapshot: object, move: object) => object}
 */
export function hopTableOver({ hopEngine, runTable }) {
  return leaseMs => {
    const { rules, table } = hopEngine({ leaseMs, leaseLapsed });
    return (snapshot, move) => runTable(table, rules, snapshot, move);
  };
}

/**
 * Provide the hop table the claim route decides with, once per serving process or handler worker.
 *
 * @param {(leaseMs: number) => (snapshot: object, move: object) => ({ refused: object } | { patch: { hop: object } })} table
 */
export function provideGateHopTable(table) {
  hopTable = typeof table === 'function' ? table : null;
}

/**
 * The claim route's hop port with gate.fencedHop on (`enabled`), else null; a serving process that never provided the table refuses rather than claim unfenced.
 *
 * @param {boolean} enabled
 * @returns {{ table: NonNullable<typeof hopTable> } | null}
 */
export function gateClaimHop(enabled) {
  if (enabled !== true) return null;
  if (!hopTable) throw new Refused('HOP_TABLE', 'gate.fencedHop is on but this board API was started without the hop table', 'restart pullboard serve, or turn gate.fencedHop off');
  return { table: hopTable };
}

/**
 * Move the item's hop row for one gate job claim: `acquire` on a claim (creating the queued hop first when none exists), `step` on a renew at the claim's epoch, `finish` when its receipt is posted.
 * Why the candidate stands for the item's commit and digest: the claim reads only the job row, and a gate job proves exactly its candidate, so the hop is per candidate.
 * A hop held by another live runner, or a renew at an epoch another runner replaced, is refused HOP_FENCED naming the owner.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ table: NonNullable<typeof hopTable> }} hop - From gateClaimHop.
 * @param {{ item: number, candidate: string, runner: string, move: 'acquire' | 'step' | 'finish', epoch?: number, job?: string, now: number, leaseMs: number }} claim - job: the gate job an acquire claims.
 * @returns {{ owner: string | null, epoch: number }}
 */
export function moveGateClaimHop(db, hop, { item, candidate, runner, move, epoch, job, now, leaseMs }) {
  const decide = hop.table(leaseMs);
  const waiting = { status: 'claimed', commit: candidate, digest: candidate };
  const write = (name, at = epoch) => gateHopMove(db, { item, actor: runner, enabled: true, decide: row => {
    // A hop that is over at another candidate is the resubmitted item's old hop: the new candidate's create replaces it, keeping its epoch so no old claim's epoch comes back [C7,#8353].
    const replaced = name === 'create' && row && reopens(row, candidate);
    const answer = decide({ item: waiting, hop: replaced ? null : row, now }, { name, actor: runner, epoch: at });
    if (answer.refused) return { refused: answer.refused };
    return { hop: replaced ? { ...answer.patch.hop, epoch: Math.max(answer.patch.hop.epoch, row.epoch) } : answer.patch.hop };
  } }).hop;
  try {
    if (move === 'step') return write('step');
    // A gate whose receipt is posted finishes its hop; a retried post finds the hop already done at this claim's epoch and leaves it [C7,#8464].
    if (move === 'finish') {
      const row = readGateHop(db, item);
      if (row?.state === 'done' && row.commit === candidate && row.epoch === epoch) return { owner: null, epoch };
      return write('finish');
    }
    // A first claim finds no row: the table creates the queued hop, then the same claim acquires it.
    ensureGateHopTable(db);
    const row = readGateHop(db, item);
    if (!row || reopens(row, candidate)) write('create');
    // A runner that released this gate job still owns its live hop: its re-claim steps the hop at its own epoch instead of waiting out its own lease [C7,#8439].
    else if (ownLiveHop(db, row, { item, candidate, runner, job, now })) return write('step', row.epoch);
    return write('acquire');
  } catch (error) {
    if (error.code === 'HOP_HELD') throw new Refused('HOP_FENCED', error.message, 'leave the gate job to the runner that owns its hop; claim again once its lease lapses');
    // A step or finish from a claim whose hop was ended or moved to a resubmitted candidate is a stale owner, fenced like a replaced epoch [C7,#8353].
    if ((move === 'step' || move === 'finish') && STALE_STEP.has(error.code)) throw new Refused('HOP_FENCED', `${runner} at epoch ${epoch} no longer owns the hop on #${item}: ${error.message}`, 'stop work on this gate job: the item was resubmitted');
    throw error;
  }
}

/**
 * Free the item's hop as a stopping runner hands back its gate job's lease: the table's fenced step checks the runner still drives the hop at its claim's epoch,
 * and the hop's lease then ends at `now`, so the next runner's claim acquires it at once (a new epoch, so the stopped claim stays fenced) instead of being refused HOP_FENCED until it lapses [C7,#8700].
 * Why only a hop this runner still drives: a hop already over, taken by another runner or lapsed has nothing of this claim's to free, so it is left as it is.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ table: NonNullable<typeof hopTable> }} hop - From gateClaimHop.
 * @param {{ job: string, runner: string, epoch: number, now: number, leaseMs?: number }} release - job: the gate job released; epoch: the hop epoch its claim took.
 * @returns {{ freed: boolean }}
 */
export function freeGateHop(db, hop, { job, runner, epoch, now, leaseMs = LEASE_MS }) {
  const { job_item: item, job_candidate: candidate } = db.prepare('SELECT job_item, job_candidate FROM job WHERE job_id = ?').get(job);
  ensureGateHopTable(db);
  const row = readGateHop(db, item);
  if (row?.state !== 'driven' || row.owner !== runner || row.epoch !== epoch || row.commit !== candidate || leaseLapsed(row.leaseUntil, now)) return { freed: false };
  const decide = hop.table(leaseMs);
  const waiting = { status: 'claimed', commit: candidate, digest: candidate };
  gateHopMove(db, { item, actor: runner, enabled: true, decide: read => {
    const answer = decide({ item: waiting, hop: read, now }, { name: 'step', actor: runner, epoch });
    return answer.refused ? { refused: answer.refused } : { hop: { ...answer.patch.hop, leaseUntil: now - 1 } };
  } });
  return { freed: true };
}

/** Refusals a step gets when its hop was ended or replaced by a resubmit rather than taken at a later epoch. */
const STALE_STEP = new Set(['HOP_OVER', 'HOP_ITEM_MOVED', 'HOP_MISSING']);

/**
 * Whether the runner owns the item's live hop at this candidate and holds no other live gate claim on the item.
 * Why the second check: two live claims sharing one epoch could both land, so only a released claim's runner takes its hop back; its old token is already dead at the job.
 */
function ownLiveHop(db, row, { item, candidate, runner, job, now }) {
  if (row.state !== 'driven' || row.owner !== runner || row.commit !== candidate || leaseLapsed(row.leaseUntil, now)) return false;
  return !db.prepare("SELECT 1 FROM job WHERE job_kind = 'gate' AND job_item = ? AND job_lease_owner = ? AND job_lease_until >= ? AND job_id <> ?").get(item, runner, now, job ?? '');
}

/**
 * Whether a claim at this candidate starts a fresh hop over the row: one over at another candidate (a resubmit's old hop), or one done at
 * this candidate (its earlier gate finished, and the gate was offered again). Why done reopens: a finished gate marks its hop done [#8464],
 * so without this a retried gate at the same candidate was refused HOP_OVER and never ran. A hop ended at this candidate stays over: a resubmit ended it.
 */
function reopens(row, candidate) {
  return overAt(row, candidate) || (row.state === 'done' && row.commit === candidate);
}

/** Whether the hop row is over (done or ended) and was for another candidate than this one. */
function overAt(row, candidate) {
  return (row.state === 'ended' || row.state === 'done') && row.commit !== candidate;
}

/**
 * End the item's open hop when its submit offers a gate job at a new candidate, so the old candidate's gate job can no longer renew or land: the table's
 * `end` move bumps the epoch, and its runner's next step is refused HOP_FENCED. No row, a hop already over, or a hop at this same candidate is left alone.
 * Why at the offer: a resubmit is the item move the hop table names as the one way a hop ends, and the offer is where the board learns the new candidate.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ table: NonNullable<typeof hopTable> } | null} hop - From gateClaimHop; null (gate.fencedHop off) reads and writes nothing.
 * @param {{ item: number, candidate: string, now: number, leaseMs?: number }} offer
 * @returns {{ ended: boolean, epoch?: number }}
 */
export function endGateHop(db, hop, { item, candidate, now, leaseMs = LEASE_MS }) {
  if (!hop) return { ended: false };
  ensureGateHopTable(db);
  const row = readGateHop(db, item);
  if (!row || row.commit === candidate || (row.state !== 'queued' && row.state !== 'driven')) return { ended: false };
  const decide = hop.table(leaseMs);
  const moved = { status: 'claimed', commit: candidate, digest: candidate };
  const ended = gateHopMove(db, { item, actor: 'submit', enabled: true, decide: read => {
    const answer = decide({ item: moved, hop: read, now }, { name: 'end', actor: 'submit' });
    return answer.refused ? { refused: answer.refused } : { hop: answer.patch.hop };
  } }).hop;
  return { ended: true, epoch: ended.epoch };
}
