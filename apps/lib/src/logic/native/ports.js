import { sealOwnershipWait } from '../../io/seal.js';
import { claimHealthSnapshot } from '../../../../../packages/health/index.js';
import { conditionalHoldFloor } from '../../../../../packages/health/index.js';
import { claimedItemRoot } from '../../../../../packages/items/index.js';
import { recordFamilyDeclareActivation } from '../../../../../packages/items/light.js';
import { withDerivedFamily } from '../../../../../packages/items/light.js';
import {
  submitGateConfig,
  submitGatePlan,
} from '../../../../../packages/gate/index.js';
import {
  nativeProofBlockingGreen,
  receiptBlockingGreen,
} from '../../../../../packages/verify/index.js';
import { reviewPatchAuthors } from '../../../../../packages/verify/index.js';
import {
  localDependencyIds,
  dependencyLabel,
} from '../../../../../packages/items/index.js';
import { itemFileCollisions } from '../../../../../packages/items/index.js';
import { warmFamilyProjection } from '../../../../../packages/items/index.js';
import { familyProjectionCurrent } from '../../../../../packages/items/index.js';
import { withLocalSeatPresence } from '../../../../../packages/store/index.js';
import { policyAt } from '../../../../../packages/sandbox/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import {
  frozenCheck,
  itemPolicy,
  requireTrunkMerge,
} from '../../../../../packages/sandbox/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { PIPELINE_CAUSE_ENGINE } from '../../../../../packages/state/light.js';
import { SUBMIT_HANDOFF_ENGINE } from '../../../../../packages/state/light.js';
import { firstRefusalDetail } from '../../../../../packages/items/index.js';
import { itemPatchDigest } from '../../../../../packages/items/index.js';
/** Supply current native engine thresholds without duplicating their values. */
function submitHandoffEngines() { return { current: ENGINE_VERSION, handoff: SUBMIT_HANDOFF_ENGINE }; }

/** Provide exact native engine thresholds for typed pipeline observations. */
function pipelineCauseEngines() { return { current: ENGINE_VERSION, pipeline: PIPELINE_CAUSE_ENGINE }; }

import { shadowSubmitHandoff } from '../../../../../packages/jobs/index.js';
import { reserveReview as reserveReviewLease } from '../../../../../packages/jobs/index.js';
import { renewReview } from '../../../../../packages/jobs/index.js';
import { reclaimLapsedReviews } from '../../../../../packages/jobs/index.js';
import { releaseReview } from '../../../../../packages/jobs/index.js';
import { submitHandoffBoardRoot } from '../../../../../packages/sandbox/index.js';
import { sealSubmitHandoffQueue } from '../../../../../packages/sandbox/index.js';
import {
  validateQuarantineProofIds,
  quarantineVerdictSnapshot,
  validateQuarantineGate,
  validateQuarantineLandingProof,
  validateQuarantineVerdict,
  recordSealedGateRun,
  sealQuarantineVerdict,
  flakeQuarantines,
  gateRuns,
  recordGateRun,
  requireBound,
} from '../../../../../packages/flakes/index.js';
import {
  sealKnownMainAutofile,
  receiptFields,
  boardReceiptStore,
  readGateReceipt,
  receiptBody,
} from '../../../../../packages/gate/index.js';
import {
  MOVE_REGISTRY,
  MOVE_OPERATIONS,
  minimumMoveEngine,
  declaredMoveActor,
  withMoveNextSteps,
} from '../../../../../packages/moves/light.js';
import {
  activeViewAgents,
  viewProofSummary,
} from '../../../../view/index.js';
import { personSigningPresentation } from '../../../../../packages/person/index.js';
import {
  personRequestStatuses,
  requestMoveProblem,
  recordRequestMove,
  relayPerson,
  requestPerson,
} from '../../../../../packages/link/index.js';
import { projectState } from '../../../../view/index.js';
import {
  projectFit,
  pendingFit,
  fitFile,
} from '../../../../../packages/blueprints/index.js';
import { verifiedPasskeyRowDecision } from '../../../../../packages/person/index.js';
import {
  advanceItemSource,
  sourceAdvanceCASProblem,
} from '../../../../../packages/sandbox/index.js';
import {
  proposeSentinel,
  decideSentinel,
  beginSentinelRun,
  finishSentinelRun,
} from '../../../../../packages/sentinels/index.js';
import {
  flakeLedger,
  recordFlakeObservation,
} from '../../../../../packages/flakes/index.js';
import {
  personProposals,
  personSigning,
  proposePersonMove,
  setPersonSigning,
  signedMoveProblem,
  exportedMeta,
  guardRestore,
} from '../../../../../packages/person/index.js';
import { recordPublishFinding } from '../../../../../packages/github/index.js';
import {
  landingWaivers,
  landingWaiverFor,
  waivedLandingProof,
} from '../../../../../packages/landing/index.js';
import {
  prepareTrainLanding,
  prepareNativeTrainLanding,
} from '../../../../../packages/landing/index.js';
import {
  sealItemPatchSubmit,
  sealItemPatchFollow,
} from '../../../../../packages/items/index.js';
import {
  sealSourceAdvance,
  sealSourceAdvanceReturn,
} from '../../../../../packages/sandbox/index.js';
import { computedReturnArgs } from '../../../../../packages/landing/index.js';
import {
  requirePreparedComputedConflict,
  preflightComputedConflict,
  conflictValue,
} from '../../../../../packages/landing/index.js';
import { validPresence } from '../../../../../packages/person/index.js';
import { recordTrainLanding } from '../../../../../packages/landing/index.js';
import {
  newRigorNotices,
  rigorNoticeText,
} from '../../../../../packages/rigor/index.js';
import { DEFAULT_NEXT_STEPS } from '../../../../../packages/state/index.js';
import * as landingEnvironment from '../../../../../packages/landing/index.js';
import {
  deriveRigorCause,
  recordAutomaticRigorDrafts,
} from '../../../../../packages/rigor/index.js';
import { normalizedDispatch } from '../../../../../packages/sentinels/index.js';
import { rejectedWorkReturns } from '../../../../../packages/sentinels/index.js';
import { guardLandingWrite } from '../../../../../packages/store/index.js';

import { recordRowVerification as applyRowVerification } from '../../../../../packages/spec/index.js';
import { decideSpecRevisions as applySpecRevisionDecisions } from '../../../../../packages/spec/index.js';
import { draftSpecRow as applySpecRowDraft } from '../../../../../packages/spec/index.js';
/** One native board composition root supplies connection-local runtime providers [C7]. */
import * as store from '../../../../../packages/store/index.js';
import {
  addMilestone,
  editMilestone,
  editMilestoneItems,
  orderMilestoneItems,
  moveMilestone,
  removeMilestone,
  roadmap,
  shipMilestone,
} from '../../../../../packages/store/index.js';
import { beginCommandPhase } from '../../../../../packages/link/index.js';

import { boardEnginePorts } from '../../../../../packages/store/index.js';
import {
  guardStore,
  refreshStoreDeclarations,
} from '../../../../../packages/store/index.js';
import {
  storeTriggers,
} from '../../../../../packages/state/index.js';
import {
  atomic,
  logEvent,
} from '../../../../../packages/store/index.js';
import {
  ensureProofCounters,
  currentProofCounters,
  proofCounter,
} from '../../../../../packages/verify/index.js';
import { ensureHotIndexes } from '../../../../../packages/store/index.js';
import { missingAdditiveIndexes } from '../../../../../packages/store/index.js';
import { ensureAdditiveIndexes } from '../../../../../packages/store/index.js';
import {
  configureBoardJournal,
  closeBoardWrites,
} from '../../../../../packages/store/index.js';
import { sharedSchemaOwner } from '../../../../../packages/store/index.js';
import { expectedBoardSchema } from '../../../../../packages/store/index.js';
import { sharedSchemaDiagnostic } from '../../../../../packages/store/index.js';
import { reportSharedSchema } from '../../../../../packages/store/index.js';
import {
  boardStanding,
  migrate,
  recordSchemaStamp,
  reportDrift,
} from '../../../../../packages/store/index.js';
import {
  openBoardReadOnly,
  readEventLogVersion,
} from '../../../../../packages/store/index.js';
import { migrateEventLogVersion } from '../../../../../packages/store/index.js';
import {
  boardNotWritable,
  boardBusyError,
} from '../../../../../packages/store/index.js';
import {
  now,
  agentAt,
  agentModel,
  proofReceipts,
  laneHold,
  laneHolds,
  itemById,
  itemCheckBaseline,
  events,
  acceptedVerdict,
  verdictReviewProblem,
  boardId,
} from '../../../../../packages/store/index.js';
import {
  appendRigorCounter,
  ensureRigorCounters,
} from '../../../../../packages/rigor/index.js';
import {
  committedItemAuthors,
  twoTierReviews,
  strictReviewProblem,
  reviewPolicyChange,
  saveItemReviewPolicy,
} from '../../../../../packages/verify/index.js';
import { holdUntilKind } from '../../../../../packages/store/index.js';
import { forgetHoldMaintenance } from '../../../../../packages/store/index.js';
import { rememberHoldCondition } from '../../../../../packages/store/index.js';
import {
  STALE_STATE_ENGINE,
} from '../../../../../packages/state/light.js';
import {
  readReceivedBoardState,
} from '../../../../../packages/store/index.js';
import {
  verdictWithdrawalTarget,
} from '../../../../../packages/verify/index.js';
import {
  computedConflictProblem,
} from '../../../../../packages/landing/index.js';
import {
  firstRefusal,
} from '../../../../../packages/store/index.js';
import {
  itemReviewPolicy,
} from '../../../../../packages/verify/index.js';

import { normalizeReviewDefaults } from '../../../../../packages/verify/index.js';

// The CLI's own next-step table, composed here from its state-cell defaults so opening a board never loads the CLI (#3906).
const NEXT_STEPS = withMoveNextSteps(DEFAULT_NEXT_STEPS);

/** Build immutable native capabilities once per connection, without a registry or cross-connection defaults; the five board operations are the host's own, passed in so this file never imports it. */
export function nativeBoardPorts({ openBoard, openBoardForRead, draftSpecRow, decideSpecRevisions, recordRowVerification }) {
  const nativePorts = Object.freeze({
    patchProof: Object.freeze({ boardReceiptStore, readGateReceipt, submitGateConfig, submitGatePlan, nativeProofBlockingGreen, receiptBlockingGreen }),
    quarantine: Object.freeze({ quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, validateQuarantineVerdict, recordSealedGateRun, sealQuarantineVerdict, gateRuns, requireBound, validateQuarantineProofIds }),
    sourceAdvanceCASProblem, beginCommandPhase, exportedMeta, guardRestore,
    newRigorNotices, rigorNoticeText, sealSourceAdvanceReturn, conflictValue, nextSteps: NEXT_STEPS, landingEnvironment, deriveRigorCause, recordAutomaticRigorDrafts, normalizedDispatch, rejectedWorkReturns,
    atomic, logEvent, rowDrafts: store.rowDrafts, rowDecisions: store.rowDecisions, PERSON: store.PERSON,
    recordRowDecisions: store.recordRowDecisions, now,
    reviewPatchAuthors, committedItemAuthors, twoTierReviews, strictReviewProblem,
    holdUntilKind, forgetHoldMaintenance, rememberHoldCondition, staleStateEngine: STALE_STATE_ENGINE,
    currentProofCounters, proofCounter,
    localDependencyIds, dependencyLabel, itemFileCollisions, withLocalSeatPresence,
    agentModel, proofReceipts, itemById, laneHold, laneHolds,
    addItem: store.addItem, agentById: store.agentById, appendFact: store.appendFact,
    getItem: store.getItem, reviewHolder: store.reviewHolder, readReceivedBoardState,
    listAgents: store.listAgents, verdictWithdrawalTarget, computedConflictProblem, firstRefusal,
    seatFamily: store.seatFamily, canonicalFamily: store.canonicalFamily,
    itemReviewPolicy, reviewPolicyChange, saveItemReviewPolicy,
    milestones: store.milestones, listItems: store.listItems, buildOrder: store.buildOrder,
    canTake: store.canTake, milestonePriorities: store.milestonePriorities, roadmap, ROUTES: store.ROUTES,
  });
  const enginePorts = boardEnginePorts({
    shadowJob: shadowSubmitHandoff,
    reviewLease: Object.freeze({ reserveReview: reserveReviewLease, renewReview, reclaimLapsedReviews, releaseReview }),
    conditionalHoldFloor, claimedItemRoot,
    recordFamilyDeclareActivation, withDerivedFamily,
    sandboxPolicyReads: Object.freeze({ mainPolicy, policyAt, frozenCheck, itemPolicy, requireTrunkMerge }),
    submitHandoffEngines, pipelineCauseEngines, firstRefusalDetail, itemPatchDigest,
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
    openBoard, openBoardForRead, draftSpecRow, decideSpecRevisions, recordRowVerification,
    addMilestone, editMilestone, editMilestoneItems, orderMilestoneItems, moveMilestone, removeMilestone, roadmap, shipMilestone
  });
  return Object.freeze({
    nativePorts, enginePorts, operations: enginePorts.operations, logEvent,
    presentation: Object.freeze({ openBoard, verifiedPasskeyRowDecision, pendingFit, projectFit, projectState, personRequestStatuses, personSigningPresentation, activeViewAgents, viewProofSummary, claimHealthSnapshot, fitFile }),
    sourceAdvanceReceipts: Object.freeze({ boardReceiptStore, readGateReceipt, receiptBody, receiptFields, guardLandingWrite }),

    verification: Object.freeze({ agentAt, itemById, itemCheckBaseline, events, acceptedVerdict, verdictReviewProblem, boardId, appendRigorCounter, ensureRigorCounters }),
    guards: Object.freeze({ guardStore, refreshStoreDeclarations, storeTriggers }),
    lifecycle: Object.freeze({ atomic, normalizeReviewDefaults: board => normalizeReviewDefaults(board, { logEvent }), ensureProofCounters, warmFamilyProjection, familyProjectionCurrent, ensureHotIndexes,
      missingAdditiveIndexes, ensureAdditiveIndexes, configureBoardJournal, closeBoardWrites }),
    query: Object.freeze({ sharedSchemaOwner, expectedBoardSchema, sharedSchemaDiagnostic, reportSharedSchema,
      boardStanding, migrate, recordSchemaStamp, reportDrift, openBoardReadOnly, readEventLogVersion, migrateEventLogVersion }),
    auth: Object.freeze({ boardNotWritable, boardBusyError }),
  });
}

/** The providers the board's public surface reaches through the host's lazy door, each defined here by its owning package. */
export { applySpecRowDraft, applySpecRevisionDecisions, applyRowVerification };
export { advanceItemSource, proposeSentinel, decideSentinel, beginSentinelRun, finishSentinelRun, flakeLedger, recordFlakeObservation };
export { flakeQuarantines, gateRuns, recordGateRun, personProposals, personSigning, proposePersonMove, setPersonSigning };
export { recordPublishFinding, landingWaivers, landingWaiverFor, waivedLandingProof, recordTrainLanding };
