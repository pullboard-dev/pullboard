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
import { receiptBody } from '../../../gate/heavy.js';
import { checkTrainLandingReceipt } from './train/receipt.js';
import { TRAIN_LANDING_ENGINE } from '../../../state/light.js';
import { validateLandingBatch } from '../../../items/index.js';
import { applyTrainCheckRepointPlan } from './train/repoints.js';
import { checkedLandingCommit } from '../../../store/index.js';
import { contains } from '../../../git/index.js';
import { git } from '../../../git/index.js';
import { mainCheckout } from '../../../git/index.js';
import { patchId } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { readTrainLandingReceipt } from './train/receipt.js';
import { prepareTrainCheckRepointPlan } from './train/repoints.js';

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

/** Derive a one-time migration annotation from the exact commit message and real parent objects. */
function migrationEnvelope(root, board, commit, base) {
  const body = git(root, ['show', '-s', '--format=%B', commit]);
  const markers = body.split('\n').filter(line => line.startsWith('Pullboard-Migration:'));
  if (!markers.length) return {};
  const parents = git(root, ['rev-list', '--parents', '-n', '1', commit]).trim().split(/\s+/u);
  if (markers.length !== 1 || markers[0] !== `Pullboard-Migration: ${base}` || parents.length !== 3
    || parents[1] !== base || landingBatches(board).some(batch => batch.state === 'landed'
      && batch.proof?.receipt && batch.tip !== commit)) {
    throw new Refused('LAND_RECEIPT_UNBOUND', 'use the once-only migration envelope with its actual published first parent');
  }
  return { migration: { version: 1, publishedBase: base, side: parents[2], tip: commit } };
}

/** Bind the complete batch membership to actual reviewed sources and the native receipt's exact envelope. */
export function prepareTrainLanding(root, board, ids, commit, receiptId) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(ids).size !== ids.length) throw new Refused('USAGE', 'name each batch item once with --items 1,2,3');
  const receipt = readTrainLandingReceipt(root, board, receiptId, commit);
  const trunk = mainCheckout(root);
  if (!trunk?.commit || !contains(root, commit, trunk.commit)) {
    throw new Refused('NOT_MERGED', 'the gated envelope must already be on the primary trunk before recording its landing');
  }
  const parent = tryGit(root, ['rev-parse', '--verify', `${commit}^1`]);
  if (parent.status !== 0) throw new Refused('LAND_RECEIPT_UNBOUND', 'a train envelope needs its real first-parent trunk base');
  const items = ids.map(id => {
    const item = getItem(board, id);
    if (item.item_status !== 'verified') throw new Refused('NOT_VERIFIED', `item #${id} is ${item.item_status}; record verified work only`);
    const checked = checkedLandingCommit(board, item);
    const oldPatch = item.item_claim_head ? patchId(root, item.item_claim_head, checked) : null;
    const currentPatch = oldPatch ? patchId(root, parent.stdout, commit) : null;
    if (!contains(root, checked, commit) && !(ids.length === 1 && oldPatch && oldPatch === currentPatch)) {
      throw new Refused('NOT_MERGED', `the envelope does not carry the reviewed source for item #${id}`);
    }
    return { id, commit: item.item_commit, merge: commit,
      ...(checked === item.item_commit ? {} : { reviewedCommit: checked }) };
  });
  const batch = {
    version: 1, id: `train-${receipt.id}`, state: 'trunk', base: parent.stdout, tip: commit,
    root, branch: trunk.branch, owner: 'coordinator-train',
    logPath: git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']) + `/pullboard/gate-receipts/${receipt.id}.json`,
    items, proof: { tree: receipt.tree }, ...migrationEnvelope(root, board, commit, parent.stdout),
  };
  return { agentId: COORDINATOR, receipt, batch,
    checkRepointPlan: prepareTrainCheckRepointPlan(root, board, batch.base, batch.tip) };
}

/** Recover an existing native batch from board history; caller batch fields never replace its sealed identity. */
export function prepareNativeTrainLanding(root, board, id, receiptId) {
  const batch = landingBatches(board).find(entry => entry.id === id);
  if (!batch || !['trunk', 'pushed', 'landed'].includes(batch.state) || batch.root !== root) {
    throw new Refused('LAND_BATCH', 'finish the exact recorded native batch from its owned worktree');
  }
  // A terminal immutable retry returns the already-recorded landing; a fresh finish still needs current authority.
  const receipt = readTrainLandingReceipt(root, board, receiptId, batch.tip, { historical: batch.state === 'landed' });
  if (batch.proof?.tree !== receipt.tree || batch.items.some(entry => entry.merge !== batch.tip)
    || git(root, ['rev-parse', 'HEAD']).trim() !== batch.tip) {
    throw new Refused('LAND_RECEIPT_UNBOUND', 'gate and retain the exact native batch envelope before finishing it');
  }
  return { agentId: COORDINATOR, nativeBatch: id, batch, receipt,
    checkRepointPlan: batch.state === 'landed' ? null : prepareTrainCheckRepointPlan(root, board, batch.base, batch.tip) };
}
