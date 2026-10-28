import { advanceItemSource } from './source-advance.js';
import {
  proposeSentinel,
  decideSentinel,
  beginSentinelRun,
  finishSentinelRun,
} from './sentinels.js';
import {
  flakeLedger,
  recordFlakeObservation,
} from './flakes.js';
import {
  flakeQuarantines,
  gateRuns,
  recordGateRun,
} from './quarantine.js';
import {
  personProposals,
  personSigning,
  proposePersonMove,
  setPersonSigning,
} from './person-signing.js';
import { recordPublishFinding } from './pr-findings.js';
import {
  landingWaivers,
  landingWaiverFor,
  waivedLandingProof,
} from './landing-waivers.js';
import { prepareTrainLanding } from './train-landing.js';
import { prepareNativeTrainLanding } from './train-landing.js';

import { sealItemPatchSubmit } from './item-patch-submit.js';
import { sealItemPatchFollow } from './item-patch-submit.js';
/** Compose the store's explicit runtime ports for deterministic state execution [C7,H16]. */
import * as rawStore from './board.js';
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
import { relaySenderPolicy } from '../packages/state/src/core/relay-sender-policy.js';
import { declaredMoveActor } from './move-registry.js';
import { validPresence } from './person-presence.js';

/** Supply native providers once when a writable board is opened; only values enter sealed moves. */
export function boardEnginePorts() {
  const store = Object.freeze({ ...rawStore, advanceItemSource, proposeSentinel, decideSentinel, beginSentinelRun, finishSentinelRun, flakeLedger, recordFlakeObservation, flakeQuarantines, gateRuns, recordGateRun, personProposals, personSigning, proposePersonMove, setPersonSigning, recordPublishFinding, landingWaivers, landingWaiverFor, waivedLandingProof });
  const { personAuthority, relayMoveActor, relaySenderProblem, validRelaySender, credentialActor } =
    relaySenderPolicy({ declaredMoveActor, validPresence });
  return Object.freeze({ store, withSeatPresence, registry: MOVE_REGISTRY, operations: MOVE_OPERATIONS,
    minimumOperationEngine: minimumMoveEngine, prepareTrainLanding, prepareNativeTrainLanding, sealItemPatchSubmit, sealItemPatchFollow, sealSourceAdvanceReturn, sealSourceAdvance,
    computedReturnArgs, requirePreparedComputedConflict, preflightComputedConflict, boundProofReceipt,
    requireOutsideReceipt, signedMoveProblem, requireCoordinatorHold, requireBound,
    requestMoveProblem, recordRequestMove, relayPerson, requestPerson,
    personAuthority, relayMoveActor, relaySenderProblem, validRelaySender, credentialActor });
}
