/** A pulled gate job's fenced hop: the runner that claims an item's gate job owns its gate_hop row, through the hop table and the store's compare-and-set [C7,#8352]. */
import { Refused } from '../../../kernel/index.js';
import { gateHopMove } from '../../../store/index.js';
import { ensureGateHopTable } from '../../../store/index.js';
import { readGateHop } from '../../../store/index.js';

/** The hop table the serving app provides: given a lease length, the table's answer for a snapshot and a move. Why provided: the API cell may not import the moves cell. */
let hopTable = null;

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
 * Move the item's hop row for one gate job claim: `acquire` on a claim (creating the queued hop first when none exists), `step` on a renew at the claim's epoch.
 * Why the candidate stands for the item's commit and digest: the claim reads only the job row, and a gate job proves exactly its candidate, so the hop is per candidate.
 * A hop held by another live runner, or a renew at an epoch another runner replaced, is refused HOP_FENCED naming the owner.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ table: NonNullable<typeof hopTable> }} hop - From gateClaimHop.
 * @param {{ item: number, candidate: string, runner: string, move: 'acquire' | 'step', epoch?: number, now: number, leaseMs: number }} claim
 * @returns {{ owner: string | null, epoch: number }}
 */
export function moveGateClaimHop(db, hop, { item, candidate, runner, move, epoch, now, leaseMs }) {
  const decide = hop.table(leaseMs);
  const waiting = { status: 'claimed', commit: candidate, digest: candidate };
  const write = name => gateHopMove(db, { item, actor: runner, enabled: true, decide: row => {
    const answer = decide({ item: waiting, hop: row, now }, { name, actor: runner, epoch });
    return answer.refused ? { refused: answer.refused } : { hop: answer.patch.hop };
  } }).hop;
  try {
    if (move === 'step') return write('step');
    // A first claim finds no row: the table creates the queued hop, then the same claim acquires it.
    ensureGateHopTable(db);
    if (!readGateHop(db, item)) write('create');
    return write('acquire');
  } catch (error) {
    if (error.code === 'HOP_HELD') throw new Refused('HOP_FENCED', error.message, 'leave the gate job to the runner that owns its hop; claim again once its lease lapses');
    throw error;
  }
}
