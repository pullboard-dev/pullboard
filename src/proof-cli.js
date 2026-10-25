/** Native command adapters record execution ids, never agent-written provenance [C7,H16]. */
import { proofRunReceipt } from './proof-receipts.js';
import { Refused } from './refused.js';

/** Bind an actual run to its native caller before the command can publish its outcome. */
export async function recordNativeProof(ctx, item, run, { ordered, withBoard, resourceAgent }, board = null) {
  // An environment refusal publishes no proof outcome; the caller preserves its ask-person refusal.
  if (run.sandboxBlocked || run.executed === false || run.checked === false) return;
  if (!run.proofReceiptId) throw new Refused('PROOF_RUN_UNAVAILABLE', 'the executed check has no native receipt; restore receipt storage and read pullboard show <id> before trying again');
  const write = target => {
    const request = { agentId: resourceAgent(ctx), itemId: item.item_id, receiptId: run.proofReceiptId };
    proofRunReceipt(target, request);
    return ordered(ctx, target, 'recordProofRun', [request]);
  };
  return board ? write(board) : withBoard(ctx, write);
}
