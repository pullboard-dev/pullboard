/** Record an exact native green train envelope through the existing atomic landing writer [B3,R3,C7]. */
import { atomic } from '../../../store/index.js';
import { finishLandingBatch } from '../../../store/index.js';
import { getItem } from '../../../store/index.js';
import { editItem } from '../../../store/index.js';
import { landingBatches } from '../../../store/index.js';
import { recordLandingBatch } from '../../../store/index.js';
import { COORDINATOR } from '../../../config/index.js';
import { ENGINE_VERSION } from '../../../state/index.js';
import { Refused } from '../../../kernel/index.js';
import { receiptBody } from '../../../gate/index.js';
import { checkTrainLandingReceipt } from './train/receipt.js';
import { TRAIN_LANDING_ENGINE } from '../../../state/light.js';
import { validateLandingBatch } from '../../../items/index.js';
import { applyTrainCheckRepointPlan } from './train/repoints.js';

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

/** Apply only the sealed, source-bound plan under this landing transaction's board write lock. */
function recordCheckRepoints(board, batch, plan, previous, landingFence) {
  if (plan === undefined || plan === null) return null;
  if (plan.base !== batch.base || plan.tip !== batch.tip) throw changedBatch();
  const report = applyTrainCheckRepointPlan(board, plan, editItem);
  return recordLandingBatch(board, { agentId: COORDINATOR,
    batch: { ...batch, checkRepointReport: report }, revision: previous?.revision ?? 0, landingFence });
}

/**
 * Bind one real native receipt to an envelope, then reuse the canonical review/fence/merged/main-moved writer.
 * Origin private-byte binding happens before writes; replay relies on receipt bytes sealed by prepareEngineMove.
 * @param {object} board native board
 * @param {{agentId:string,batch:object,receipt:object,landingFence?:object}} request sealed native landing
 * @returns {object} the terminal native landed batch
 */
export function recordTrainLanding(board, { agentId, batch, receipt, landingFence, nativeBatch, checkRepointPlan }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator records a train landing');
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < TRAIN_LANDING_ENGINE) {
    throw new Refused('ENGINE_VERSION', `train landing receipts require engine ${TRAIN_LANDING_ENGINE}; upgrade Pullboard`);
  }
  const value = checkTrainLandingReceipt(receipt, batch?.tip);
  if (board.executionEngineVersion === undefined) board.nativePorts.quarantine.requireBound(board, value);
  return atomic(board, () => {
    if (!batch || batch.id !== (nativeBatch ?? `train-${value.id}`) || !Array.isArray(batch.items) || !batch.items.length
      || new Set(batch.items.map(entry => entry?.id)).size !== batch.items.length
      || batch.items.some(entry => entry?.merge !== value.head)
      || batch.proof?.tree !== value.tree) throw changedBatch();
    validateLandingBatch({ ...batch, state: 'trunk' }, 0);
    const previous = landingBatches(board).find(entry => entry.id === batch.id);
    if (previous && nativeBatch && previous.state !== 'landed') {
      if (JSON.stringify(previous) !== JSON.stringify(batch) || !['trunk', 'pushed'].includes(previous.state)
        || receiptBody(previous.proof?.receipt) !== receiptBody(value)) throw changedBatch();
      board.nativePorts.quarantine.validateQuarantineVerdict(board, value);
      const first = getItem(board, batch.items[0].id);
      board.nativePorts.quarantine.recordSealedGateRun(board, { agentId, receipt: value, lane: first.item_lane });
      const planned = recordCheckRepoints(board, batch, checkRepointPlan, previous, landingFence);
      return finishLandingBatch(board, { agentId, id: planned?.id ?? batch.id, tip: value.head, landingFence });
    }
    if (nativeBatch && !previous) throw changedBatch();
    if (previous) {
      if (!sameLanding(previous, batch, value)) throw changedBatch();
      return previous;
    }
    board.nativePorts.quarantine.validateQuarantineVerdict(board, value);
    // All writes remain inside this transaction: any native batch, fence or review refusal rolls them back.
    const first = getItem(board, batch.items[0].id);
    board.nativePorts.quarantine.recordSealedGateRun(board, { agentId, receipt: value, lane: first.item_lane });
    const trunkBatch = { ...batch, state: 'trunk',
      proof: { tree: value.tree, failures: [], logPath: batch.logPath, receipt: value } };
    const recorded = recordCheckRepoints(board, trunkBatch, checkRepointPlan, null, landingFence)
      ?? recordLandingBatch(board, { agentId, batch: trunkBatch, revision: 0, landingFence });
    return finishLandingBatch(board, { agentId, id: recorded.id, tip: value.head, landingFence });
  });
}
