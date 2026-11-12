import { deferOwnership } from './wait.js';
import { Refused } from "../../../../kernel/index.js";

/** Compose the store's explicit runtime ports for deterministic state execution [C7,H16]. */
import * as rawStore from "../board.js";
import { measureBoardWritePhase } from './write/lock.js';
import { withSeatPresence } from "../presence.js";

import { boundProofReceipt } from "../receipts.js";
import { requireOutsideReceipt } from "../../../../items/index.js";

import { requireCoordinatorHold } from "../../../../seats/index.js";

import { relaySenderPolicy } from "../../../../state/index.js";

/** Supply native providers once when a writable board is opened; only values enter sealed moves. */
export function boardEnginePorts(providers) {
  if (!providers?.MOVE_REGISTRY || typeof providers.MOVE_REGISTRY !== 'object' || Array.isArray(providers.MOVE_REGISTRY)) throw new Refused('NO_POLICY', 'Supply the explicit native engine provider MOVE_REGISTRY before opening storage.');
  if (!Array.isArray(providers?.MOVE_OPERATIONS)) throw new Refused('NO_POLICY', 'Supply the explicit native engine provider MOVE_OPERATIONS before opening storage.');
  for (const name of [
    'conditionalHoldFloor', 'claimedItemRoot', 'submitHandoffEngines', 'pipelineCauseEngines', 'firstRefusalDetail', 'itemPatchDigest', 'recordFamilyDeclareActivation', 'withDerivedFamily',
    'minimumMoveEngine', 'declaredMoveActor',
    'recordTrainLanding', 'advanceItemSource', 'proposeSentinel', 'decideSentinel',
    'beginSentinelRun', 'finishSentinelRun', 'flakeLedger', 'recordFlakeObservation',
    'flakeQuarantines', 'gateRuns', 'recordGateRun', 'personProposals',
    'personSigning', 'proposePersonMove', 'setPersonSigning', 'recordPublishFinding',
    'landingWaivers', 'landingWaiverFor', 'waivedLandingProof', 'prepareTrainLanding',
    'prepareNativeTrainLanding', 'sealKnownMainAutofile', 'sealSubmitHandoffQueue', 'sealOwnershipWait', 'submitHandoffBoardRoot', 'sealItemPatchSubmit', 'sealItemPatchFollow', 'sealSourceAdvanceReturn',
    'sealSourceAdvance', 'computedReturnArgs', 'requirePreparedComputedConflict', 'preflightComputedConflict',
    'signedMoveProblem', 'requireBound', 'requestMoveProblem', 'recordRequestMove',
    'relayPerson', 'requestPerson', 'validPresence',
    'openBoard', 'openBoardForRead', 'draftSpecRow', 'decideSpecRevisions', 'recordRowVerification', 'addMilestone', 'editMilestone', 'editMilestoneItems', 'orderMilestoneItems', 'moveMilestone', 'removeMilestone', 'roadmap', 'shipMilestone'
  ]) {
    if (typeof providers?.[name] !== 'function') throw new Refused('NO_POLICY', `Supply the explicit native engine provider ${name} before opening storage.`);
  }
  for (const name of ['mainPolicy', 'policyAt', 'frozenCheck', 'itemPolicy', 'requireTrunkMerge']) {
    if (typeof providers.sandboxPolicyReads?.[name] !== 'function') throw new Refused('NO_POLICY', `Supply the explicit native engine provider sandboxPolicyReads.${name} before opening storage.`);
  }
  const {
    conditionalHoldFloor, claimedItemRoot, submitHandoffEngines, pipelineCauseEngines, firstRefusalDetail, itemPatchDigest, recordFamilyDeclareActivation, withDerivedFamily,
    MOVE_REGISTRY, MOVE_OPERATIONS, minimumMoveEngine, declaredMoveActor,
    recordTrainLanding, advanceItemSource, proposeSentinel, decideSentinel,
    beginSentinelRun, finishSentinelRun, flakeLedger, recordFlakeObservation,
    flakeQuarantines, gateRuns, recordGateRun, personProposals,
    personSigning, proposePersonMove, setPersonSigning, recordPublishFinding,
    landingWaivers, landingWaiverFor, waivedLandingProof, prepareTrainLanding,
    prepareNativeTrainLanding, sealKnownMainAutofile, sealSubmitHandoffQueue, sealOwnershipWait, submitHandoffBoardRoot, sealItemPatchSubmit, sealItemPatchFollow, sealSourceAdvanceReturn,
    sealSourceAdvance, computedReturnArgs, requirePreparedComputedConflict, preflightComputedConflict,
    signedMoveProblem, requireBound, requestMoveProblem, recordRequestMove,
    relayPerson, requestPerson, validPresence,
    openBoard, openBoardForRead, draftSpecRow, decideSpecRevisions, recordRowVerification, addMilestone, editMilestone, editMilestoneItems, orderMilestoneItems, moveMilestone, removeMilestone, roadmap, shipMilestone
  } = providers;
  const store = Object.freeze({ ...rawStore, deferOwnership, measureBoardWritePhase, recordTrainLanding, advanceItemSource, proposeSentinel, decideSentinel, beginSentinelRun, finishSentinelRun, flakeLedger, recordFlakeObservation, flakeQuarantines, gateRuns, recordGateRun, personProposals, personSigning, proposePersonMove, setPersonSigning, recordPublishFinding, landingWaivers, landingWaiverFor, waivedLandingProof, openBoard, openBoardForRead, draftSpecRow, decideSpecRevisions, recordRowVerification, addMilestone, editMilestone, editMilestoneItems, orderMilestoneItems, moveMilestone, removeMilestone, roadmap, shipMilestone });
  const { personAuthority, relayMoveActor, relaySenderProblem, validRelaySender, credentialActor } =
    relaySenderPolicy({ declaredMoveActor, validPresence });
  return Object.freeze({ sealOwnershipWait, shadowJob: providers.shadowJob, reviewLease: providers.reviewLease, sandboxPolicyReads: providers.sandboxPolicyReads, store, withSeatPresence, claimedItemRoot, submitHandoffEngines, pipelineCauseEngines, firstRefusalDetail, itemPatchDigest, recordFamilyDeclareActivation, withDerivedFamily, registry: MOVE_REGISTRY, operations: MOVE_OPERATIONS,
    minimumOperationEngine: (operation, args, board, at, context) => minimumMoveEngine(operation, args, board, at, conditionalHoldFloor, context), prepareTrainLanding, prepareNativeTrainLanding, sealKnownMainAutofile, sealSubmitHandoffQueue, submitHandoffBoardRoot, sealItemPatchSubmit, sealItemPatchFollow, sealSourceAdvanceReturn, sealSourceAdvance,
    computedReturnArgs, requirePreparedComputedConflict, preflightComputedConflict, boundProofReceipt,
    requireOutsideReceipt, signedMoveProblem, requireCoordinatorHold, requireBound,
    requestMoveProblem, recordRequestMove, relayPerson, requestPerson,
    personAuthority, relayMoveActor, relaySenderProblem, validRelaySender, credentialActor });
}
