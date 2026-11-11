import { receiptBlockingGreen } from '../../../../verify/index.js';
/** Native exact-envelope landing evidence; origin binds bytes and replay checks sealed fields [C7,B3]. */
import { createHash } from 'node:crypto';
import { git } from '../../../../git/index.js';
import { boardReceiptStore } from '../../../../gate/index.js';
import { readGateReceipt } from '../../../../gate/index.js';
import { receiptBinds } from '../../../../gate/index.js';
import { receiptFields } from '../../../../gate/index.js';
import { Refused } from '../../../../kernel/index.js';
import { policyAt } from '../../../../sandbox/index.js';

/** Return the same actionable refusal for absent, altered, stale or differently scoped evidence. */
function unboundReceipt() {
  return new Refused('LAND_RECEIPT_UNBOUND',
    'run the native landing gate on the exact clean batch envelope with its accepted policy, then pass that gate receipt ID');
}

/**
 * Validate canonical sealed fields without reading files or Git. This does not establish origin authority:
 * prepareEngineMove must bind the stored receipt before sealing it for deterministic replay.
 * @param {object} receipt native receipt bytes already bound at origin
 * @param {string} commit exact envelope commit to be recorded
 * @returns {object} canonical receipt fields
 */
export function checkTrainLandingReceipt(receipt, commit) {
  const value = receiptFields(receipt);
  if (!value || value.version !== 1 || value.kind !== 'land' || !receiptBlockingGreen(value)
    || Object.hasOwn(value, 'collection') || value.head !== commit) throw unboundReceipt();
  return value;
}

/**
 * Read only the gate's own private receipt and bind its exact envelope tree and pinned accepted command.
 * Caller exit codes, trees and command assertions are never accepted as evidence.
 * @param {string} root repository holding the exact envelope Git object
 * @param {object} board native board whose receipt store owns the evidence
 * @param {string} id native gate receipt ID
 * @param {string} commit exact envelope commit to be recorded
 * @returns {object} canonical native receipt suitable for origin sealing
 */
export function readTrainLandingReceipt(root, board, id, commit, { historical = false } = {}) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Refused('LAND_RECEIPT_REQUIRED',
      'run the native landing gate on the batch envelope and pass its receipt ID when recording the landing');
  }
  try {
    const store = boardReceiptStore(board);
    const value = checkTrainLandingReceipt(readGateReceipt(store, id), commit);
    if (!receiptBinds(store, value)) throw unboundReceipt();
    board.nativePorts.quarantine.sealQuarantineVerdict(board, value, { historical });
    const tree = git(root, ['rev-parse', '--verify', `${commit}^{tree}`]).trim();
    const command = policyAt(root, value.main).config.gate;
    if (typeof command !== 'string' || !command.trim() || tree !== value.tree
      || createHash('sha256').update(command).digest('hex') !== value.command) throw unboundReceipt();
    return value;
  } catch {
    throw unboundReceipt();
  }
}
