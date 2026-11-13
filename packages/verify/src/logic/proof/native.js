/** Native command adapters record execution ids, never agent-written provenance [C7,H16]. */
import { Refused } from '../../../../kernel/index.js';

/** Bind a run using the native adapter’s explicit receipt validator before publishing its outcome. */
export async function recordNativeProof(ctx, item, run, { ordered, withBoard, resourceAgent, proofRunReceipt, exitFailures = false }, board = null) {
  // An environment refusal publishes no proof outcome; the caller preserves its ask-person refusal.
  if (run.sandboxBlocked || run.executed === false || run.checked === false) return;
  if (!run.proofReceiptId) throw missingReceipt(ctx, item, resourceAgent);
  const write = target => {
    const request = { agentId: resourceAgent(ctx), itemId: item.item_id, receiptId: run.proofReceiptId, ...(exitFailures ? { exitFailures: true } : {}) };
    proofRunReceipt(target, request);
    return ordered(ctx, target, 'recordProofRun', [request]);
  };
  return board ? write(board) : withBoard(ctx, write);
}

/**
 * Why an executed check has no receipt. An item folder names its seat only while that seat holds the item, so a check
 * run after the claim lapsed has no seat to sign its receipt; that case names the renewal, never missing storage.
 */
function missingReceipt(ctx, item, resourceAgent) {
  let seat = null;
  try { seat = resourceAgent(ctx); } catch { /* An unreadable board stays the storage refusal below. */ }
  if (!seat) return new Refused('NOT_HOLDING', `this folder's seat no longer holds #${item.item_id}, so its check could sign no proof; renew the claim with pullboard claim ${item.item_id}, then run pullboard check ${item.item_id} --yes`);
  return new Refused('PROOF_RUN_UNAVAILABLE', 'the executed check has no native receipt; restore receipt storage and read pullboard show <id> before trying again');
}
