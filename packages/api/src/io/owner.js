/** Route a pulled gate's green proof of foreign paths to their lane owners, as the controller submit does [B3,L1,P7]. */
import { store } from './gate/moves.js';

/**
 * True when a gate receipt's only finding is lane ownership: every phase ran and passed, nothing else refused.
 * Why: only exact green proof may route to owners; any red, infra or shard plan stays the builder's red [B3,V4].
 * @param {Record<string, any> | null | undefined} receipt
 */
export function ownershipOnly(receipt) {
  const gate = receipt?.gate ?? {}, phases = gate.phases ?? [];
  return Boolean(gate.analysis?.ownership?.paths?.length) && !gate.error && !gate.analysis.infra && !gate.analysis.refusals?.length
    && !gate.proofPlan && phases.length > 0 && phases.every(phase => phase.status === 0);
}

/**
 * Hold the item for the owners of its foreign paths, freeing the builder, from the gate's recorded phase receipts.
 * Why a separate step from submit: an owner wait is never a submission; the board seals the source from the builder's
 * own checkout, exactly as the controller path does after its local green proof [B3,L1,V4].
 *
 * @param {any} board
 * @param {{ job: string, id: number, candidate: string, main: string, submit: Record<string, any>, receiptIds: string[] }} routed
 * @returns {{ applied: true, outcome: 'ownership', owners: string[], paths: string[] } | { refused: string }} refused names why the board could not route
 */
export function routePulledOwnership(board, { job, id, candidate, main, submit, receiptIds }) {
  if (submit.companion) return { refused: 'a companion submit cannot route ownership' };
  if (typeof submit.root !== 'string' || !submit.root) return { refused: 'the gate offer carries no builder checkout to seal the source from' };
  if (!receiptIds.length) return { refused: 'the gate recorded no proof-run receipts' };
  let wait;
  try {
    wait = store.deferOwnership(board, id, { agentId: submit.agentId, root: submit.root, commit: candidate, tree: submit.tree, main, receiptIds });
  } catch (error) {
    if (!error?.code) throw error;
    return { refused: `${error.code}: ${error.message}` };
  }
  store.appendFact(board, id, { agentId: submit.agentId, kind: 'note',
    text: `Gate job ${job} green at ${candidate.slice(0, 12)} on main ${String(main).slice(0, 12)}; it waits on ${wait.owners.join(', ')} for ${wait.paths.join(', ')}, and the builder's claim is released.`.slice(0, 2000) });
  // The shout only wakes the builder; the hold and the fact above are the record.
  try {
    store.shout(board, { from: 'coordinator', to: submit.agentId, lanes: [], item: id,
      text: `#${id} waits on ${wait.owners.join(', ')} ownership of ${wait.paths.join(', ')}; your claim is released`.slice(0, 280) });
  } catch (error) { if (error?.code === undefined) throw error; }
  return { applied: true, outcome: 'ownership', owners: wait.owners, paths: wait.paths };
}
