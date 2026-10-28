import { Refused } from './refused.js';

/** Compose the store's explicit runtime ports for deterministic state execution [C7,H16]. */
import * as rawStore from './board.js';
import { withSeatPresence } from './seat-presence.js';
import { MOVE_REGISTRY } from './move-registry.js';
import { MOVE_OPERATIONS } from './move-registry.js';
import { minimumMoveEngine } from './move-registry.js';

import { boundProofReceipt } from './proof-receipts.js';
import { requireOutsideReceipt } from './outside-proof.js';

import { requireCoordinatorHold } from './coordinator-hold.js';

import { relaySenderPolicy } from '../packages/state/src/core/relay-sender-policy.js';
import { declaredMoveActor } from './move-registry.js';

/** Supply native providers once when a writable board is opened; only values enter sealed moves. */
export function boardEnginePorts(providers) {
  for (const name of [
    'recordTrainLanding', 'advanceItemSource', 'proposeSentinel', 'decideSentinel',
    'beginSentinelRun', 'finishSentinelRun', 'flakeLedger', 'recordFlakeObservation',
    'flakeQuarantines', 'gateRuns', 'recordGateRun', 'personProposals',
    'personSigning', 'proposePersonMove', 'setPersonSigning', 'recordPublishFinding',
    'landingWaivers', 'landingWaiverFor', 'waivedLandingProof', 'prepareTrainLanding',
    'prepareNativeTrainLanding', 'sealItemPatchSubmit', 'sealItemPatchFollow', 'sealSourceAdvanceReturn',
    'sealSourceAdvance', 'computedReturnArgs', 'requirePreparedComputedConflict', 'preflightComputedConflict',
    'signedMoveProblem', 'requireBound', 'requestMoveProblem', 'recordRequestMove',
    'relayPerson', 'requestPerson', 'validPresence'
  ]) {
    if (typeof providers?.[name] !== 'function') throw new Refused('NO_POLICY', `Supply the explicit native engine provider ${name} before opening storage.`);
  }
  const {
    recordTrainLanding, advanceItemSource, proposeSentinel, decideSentinel,
    beginSentinelRun, finishSentinelRun, flakeLedger, recordFlakeObservation,
    flakeQuarantines, gateRuns, recordGateRun, personProposals,
    personSigning, proposePersonMove, setPersonSigning, recordPublishFinding,
    landingWaivers, landingWaiverFor, waivedLandingProof, prepareTrainLanding,
    prepareNativeTrainLanding, sealItemPatchSubmit, sealItemPatchFollow, sealSourceAdvanceReturn,
    sealSourceAdvance, computedReturnArgs, requirePreparedComputedConflict, preflightComputedConflict,
    signedMoveProblem, requireBound, requestMoveProblem, recordRequestMove,
    relayPerson, requestPerson, validPresence
  } = providers;
  const store = Object.freeze({ ...rawStore, recordTrainLanding, advanceItemSource, proposeSentinel, decideSentinel, beginSentinelRun, finishSentinelRun, flakeLedger, recordFlakeObservation, flakeQuarantines, gateRuns, recordGateRun, personProposals, personSigning, proposePersonMove, setPersonSigning, recordPublishFinding, landingWaivers, landingWaiverFor, waivedLandingProof });
  const { personAuthority, relayMoveActor, relaySenderProblem, validRelaySender, credentialActor } =
    relaySenderPolicy({ declaredMoveActor, validPresence });
  return Object.freeze({ store, withSeatPresence, registry: MOVE_REGISTRY, operations: MOVE_OPERATIONS,
    minimumOperationEngine: minimumMoveEngine, prepareTrainLanding, prepareNativeTrainLanding, sealItemPatchSubmit, sealItemPatchFollow, sealSourceAdvanceReturn, sealSourceAdvance,
    computedReturnArgs, requirePreparedComputedConflict, preflightComputedConflict, boundProofReceipt,
    requireOutsideReceipt, signedMoveProblem, requireCoordinatorHold, requireBound,
    requestMoveProblem, recordRequestMove, relayPerson, requestPerson,
    personAuthority, relayMoveActor, relaySenderProblem, validRelaySender, credentialActor });
}
