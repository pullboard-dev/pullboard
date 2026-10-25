import { proofReceipts } from './board-query.js';
export { proofReceipts };
/** Stamp the gate's own immutable receipt with the board's seat and recorded parent [C7,H16]. */
import {
  atomic,
  getItem,
  listAgents,
  logEvent,
} from './board.js';
import {
  boardReceiptStore,
  readGateReceipt,
  receiptBody,
  receiptFields,
} from './gate-run-receipt.js';
import { ENGINE_VERSION } from './machine.js';
import { PROOF_RUN_ENGINE } from './proof-run-engine.js';
import { Refused } from './refused.js';
import * as seats from './seats.js';

/** Read the native gate's file before sealing a replayable move; caller-supplied fields are not evidence. */
export function boundProofReceipt(board, request) {
  const id = request?.receiptId ?? request?.receipt?.id;
  const stored = readGateReceipt(boardReceiptStore(board), id);
  if (!stored || stored.version !== 2 || request?.receipt && receiptBody(request.receipt) !== receiptBody(stored)) {
    throw new Refused('PROOF_RUN_UNBOUND', 'proof provenance comes from the gate receipt it stored; run the check, then read pullboard show <id>');
  }
  return stored;
}

/** Validate native facts against current board-owned identities without changing the board. */
export function proofRunReceipt(board, request) {
  const { agentId, itemId } = request;
  if (!listAgents(board).some(agent => agent.agent_id === agentId)) throw new Refused('NOT_JOINED', 'join before recording a proof run');
  // Only the engine establishes this in-process replay context after origin sealing, as for legacy gate runs.
  // A replica cannot read the origin's receipt file; normal direct calls always require that file.
  const run = board.executionEngineVersion === undefined ? boundProofReceipt(board, request) : receiptFields(request.receipt);
  if (!run || run.version !== 2 || run.proof.item !== itemId) throw new Refused('PROOF_RUN_UNBOUND', 'the native receipt must name this item; run its check and read pullboard show <id>');
  if (run.proof.seat !== agentId) throw new Refused('PROOF_RUN_ACTOR', 'the native receipt belongs to another seat; use the receipts from your own check');
  const item = getItem(board, itemId);
  if (run.proof.frozenDigest !== (item.item_frozen_digest ?? null)) throw new Refused('PROOF_RUN_STALE', 'the criterion changed during this proof; read pullboard show <id> before checking again');
  const receipt = { id: run.id, kind: run.kind, item: itemId, commit: run.head, tree: run.tree,
    frozenDigest: run.proof.frozenDigest, environment: run.proof.environment, runner: run.proof.runner,
    seat: agentId, parentSession: seats.agentParent?.(board, agentId) ?? null, exitCode: run.proof.exitCode,
    counts: run.proof.counts, durationMs: run.proof.durationMs, sourceClean: run.proof.sourceClean, at: run.at,
    ...(Object.hasOwn(run.proof, 'testRuntimes') ? { testRuntimes: run.proof.testRuntimes } : {}) };
  const existing = proofReceipts(board, itemId).find(value => value.id === receipt.id);
  if (existing) {
    const { eventId, ...fields } = existing;
    // Later registration cannot retroactively upgrade an originally unknown parent.
    receipt.parentSession = existing.parentSession;
    if (JSON.stringify(fields) !== JSON.stringify(receipt)) throw new Refused('PROOF_RUN_CHANGED', 'that receipt id already binds different facts; keep the original and run a new check');
  }
  return { receipt, existing };
}

/** Record native facts atomically, revalidating after the native adapter's read-only preflight. */
export function recordProofRun(board, request) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < PROOF_RUN_ENGINE) {
    throw new Refused('ENGINE_VERSION', `proof receipts require engine ${PROOF_RUN_ENGINE}; upgrade Pullboard`);
  }
  return atomic(board, () => {
    const { receipt, existing } = proofRunReceipt(board, request);
    if (existing) return existing;
    logEvent(board, request.agentId, 'proof-run', request.itemId, { engine: PROOF_RUN_ENGINE, receipt });
    return receipt;
  });
}

/** A short pointer replaces repeated provenance narratives in shouts. */
export function refuseLongShout(text) {
  if (Array.from(String(text)).length > 400) {
    throw new Refused('SHOUT_TOO_LONG', 'a shout is at most 400 characters; cite proof receipt ids and use pullboard show <id> for the chain');
  }
}
