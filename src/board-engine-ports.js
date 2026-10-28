/** Compose the store's explicit runtime ports for deterministic state execution [C7,H16]. */
import { withSeatPresence } from './seat-presence.js';
import { MOVE_REGISTRY } from './move-registry.js';
import { MOVE_OPERATIONS } from './move-registry.js';
import { minimumMoveEngine } from './move-registry.js';
import { sealSourceAdvanceReturn } from './source-advance-origin.js';
import { sealSourceAdvance } from './source-advance-origin.js';
import { computedReturnArgs } from './computed-conflict-return.js';
import { requirePreparedComputedConflict } from './computed-conflict-receipt.js';
import { preflightComputedConflict } from './computed-conflict-receipt.js';
import { boundProofReceipt } from './proof-receipts.js';
import { requireOutsideReceipt } from './outside-proof.js';
import { signedMoveProblem } from './person-signing.js';
import { requireCoordinatorHold } from './coordinator-hold.js';
import { requireBound } from './quarantine.js';
import { requestMoveProblem } from './relay-requests.js';
import { recordRequestMove } from './relay-requests.js';
import { relayPerson } from './relay-requests.js';
import { requestPerson } from './relay-requests.js';
import { personAuthority } from './relay-sender.js';
import { relayMoveActor } from './relay-sender.js';
import { relaySenderProblem } from './relay-sender.js';
import { validRelaySender } from './relay-sender.js';

/** Supply native providers once when a writable board is opened; only values enter sealed moves. */
export function boardEnginePorts(store) {
  if (!store || typeof store.openBoard !== 'function') throw new TypeError('The native root must supply its canonical board API.');
  return Object.freeze({ store, withSeatPresence, registry: MOVE_REGISTRY, operations: MOVE_OPERATIONS,
    minimumOperationEngine: minimumMoveEngine, sealSourceAdvanceReturn, sealSourceAdvance,
    computedReturnArgs, requirePreparedComputedConflict, preflightComputedConflict, boundProofReceipt,
    requireOutsideReceipt, signedMoveProblem, requireCoordinatorHold, requireBound,
    requestMoveProblem, recordRequestMove, relayPerson, requestPerson,
    personAuthority, relayMoveActor, relaySenderProblem, validRelaySender });
}
