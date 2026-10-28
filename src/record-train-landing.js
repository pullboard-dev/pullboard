/** Record an exact native green train envelope through the existing atomic landing writer [B3,R3,C7]. */
import { atomic } from './board.js';
import { finishLandingBatch } from './board.js';
import { getItem } from './board.js';
import { landingBatches } from './board.js';
import { recordLandingBatch } from './board.js';
import { COORDINATOR } from './config.js';
import { ENGINE_VERSION } from './machine.js';
import { recordGateRun } from './quarantine.js';
import { requireBound } from './quarantine.js';
import { Refused } from './refused.js';
import { receiptBody } from './gate-run-receipt.js';
import { checkTrainLandingReceipt } from './train-landing-receipt.js';
import { TRAIN_LANDING_ENGINE } from './train-landing-engine.js';
import { validateLandingBatch } from './submit-invariants.js';

/** Refuse a conflicting envelope rather than treating a reused native receipt as another landing. */
function changedBatch() {
  return new Refused('LAND_RECEIPT_UNBOUND',
    'keep the exact gated envelope, item sources and receipt; rebuild and gate a new envelope if any changed');
}

/** Normalize only the immutable item identity used by the existing landing writer. */
function itemIdentity(items) {
  return items.map(({ id, commit, merge, reviewedCommit }) => ({ id, commit, merge,
    ...(reviewedCommit === undefined ? {} : { reviewedCommit }) }));
}

/** Compare an already-landed envelope without its writer-generated revision and timestamps. */
function sameLanding(previous, batch, receipt) {
  return previous.state === 'landed' && previous.base === batch.base && previous.tip === batch.tip
    && previous.root === batch.root && previous.branch === batch.branch && previous.owner === batch.owner
    && previous.logPath === batch.logPath && previous.proof?.tree === receipt.tree
    && receiptBody(previous.proof?.receipt) === receiptBody(receipt)
    && JSON.stringify(itemIdentity(previous.items)) === JSON.stringify(itemIdentity(batch.items));
}

/**
 * Bind one real native receipt to an envelope, then reuse the canonical review/fence/merged/main-moved writer.
 * Origin private-byte binding happens before writes; replay relies on receipt bytes sealed by prepareEngineMove.
 * @param {object} board native board
 * @param {{agentId:string,batch:object,receipt:object,landingFence?:object}} request sealed native landing
 * @returns {object} the terminal native landed batch
 */
export function recordTrainLanding(board, { agentId, batch, receipt, landingFence, nativeBatch }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator records a train landing');
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < TRAIN_LANDING_ENGINE) {
    throw new Refused('ENGINE_VERSION', `train landing receipts require engine ${TRAIN_LANDING_ENGINE}; upgrade Pullboard`);
  }
  return atomic(board, () => {
    const value = checkTrainLandingReceipt(receipt, batch?.tip);
    if (!batch || batch.id !== (nativeBatch ?? `train-${value.id}`) || !Array.isArray(batch.items) || !batch.items.length
      || new Set(batch.items.map(entry => entry?.id)).size !== batch.items.length
      || batch.items.some(entry => entry?.merge !== value.head)
      || batch.proof?.tree !== value.tree) throw changedBatch();
    validateLandingBatch({ ...batch, state: 'trunk' }, 0);
    if (board.executionEngineVersion === undefined) requireBound(board, value);
    const previous = landingBatches(board).find(entry => entry.id === batch.id);
    if (previous && nativeBatch && previous.state !== 'landed') {
      if (JSON.stringify(previous) !== JSON.stringify(batch) || !['trunk', 'pushed'].includes(previous.state)
        || receiptBody(previous.proof?.receipt) !== receiptBody(value)) throw changedBatch();
      const first = getItem(board, batch.items[0].id);
      recordGateRun(board, { agentId, receipt: value, lane: first.item_lane });
      return finishLandingBatch(board, { agentId, id: batch.id, tip: value.head, landingFence });
    }
    if (nativeBatch && !previous) throw changedBatch();
    if (previous) {
      if (!sameLanding(previous, batch, value)) throw changedBatch();
      return previous;
    }
    // All writes remain inside this transaction: any native batch, fence or review refusal rolls them back.
    const first = getItem(board, batch.items[0].id);
    recordGateRun(board, { agentId, receipt: value, lane: first.item_lane });
    const recorded = recordLandingBatch(board, { agentId, batch: { ...batch, state: 'trunk',
      proof: { tree: value.tree, failures: [], logPath: batch.logPath, receipt: value } }, revision: 0, landingFence });
    return finishLandingBatch(board, { agentId, id: recorded.id, tip: value.head, landingFence });
  });
}
