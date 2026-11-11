import { sealOwnershipWait } from '../io/seal.js';
import { claimHealthSnapshot } from '../../../../packages/health/index.js';
import { conditionalHoldFloor } from '../../../../packages/health/index.js';
import { claimedItemRoot } from '../../../../packages/items/index.js';
import { recordFamilyDeclareActivation } from '../../../../packages/items/light.js';
import { withDerivedFamily } from '../../../../packages/items/light.js';
import {
  submitGateConfig,
  submitGatePlan,
} from '../../../../packages/gate/index.js';
import {
  nativeProofBlockingGreen,
  receiptBlockingGreen,
} from '../../../../packages/verify/index.js';
import { reviewPatchAuthors } from '../../../../packages/verify/index.js';
import {
  localDependencyIds,
  dependencyLabel,
} from '../../../../packages/items/index.js';
import { itemFileCollisions } from '../../../../packages/items/index.js';
import { warmFamilyProjection } from '../../../../packages/items/index.js';
import { familyProjectionCurrent } from '../../../../packages/items/index.js';
import { withLocalSeatPresence } from '../../../../packages/store/index.js';
import { policyAt } from '../../../../packages/sandbox/index.js';
import { mainPolicy } from '../../../../packages/sandbox/index.js';
import {
  frozenCheck,
  itemPolicy,
  requireTrunkMerge,
} from '../../../../packages/sandbox/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { PIPELINE_CAUSE_ENGINE } from '../../../../packages/state/light.js';
import { SUBMIT_HANDOFF_ENGINE } from '../../../../packages/state/light.js';
import { firstRefusalDetail } from '../../../../packages/items/index.js';
import { itemPatchDigest } from '../../../../packages/items/index.js';
/** Supply current native engine thresholds without duplicating their values. */
function submitHandoffEngines() { return { current: ENGINE_VERSION, handoff: SUBMIT_HANDOFF_ENGINE }; }

/** Provide exact native engine thresholds for typed pipeline observations. */
function pipelineCauseEngines() { return { current: ENGINE_VERSION, pipeline: PIPELINE_CAUSE_ENGINE }; }

import { shadowSubmitHandoff } from '../../../../packages/jobs/index.js';
import { reserveReview as reserveReviewLease } from '../../../../packages/jobs/index.js';
import { renewReview } from '../../../../packages/jobs/index.js';
import { reclaimLapsedReviews } from '../../../../packages/jobs/index.js';
import { releaseReview } from '../../../../packages/jobs/index.js';
import { submitHandoffBoardRoot } from '../../../../packages/sandbox/index.js';
import { sealSubmitHandoffQueue } from '../../../../packages/sandbox/index.js';
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
} from '../../../../packages/flakes/index.js';
import {
  sealKnownMainAutofile,
  receiptFields,
  boardReceiptStore,
  readGateReceipt,
  receiptBody,
} from '../../../../packages/gate/index.js';
import {
  MOVE_REGISTRY,
  MOVE_OPERATIONS,
  minimumMoveEngine,
  declaredMoveActor,
  withMoveNextSteps,
} from '../../../../packages/moves/index.js';
import {
  activeViewAgents,
  viewProofSummary,
} from '../../../view/index.js';
import { personSigningPresentation } from '../../../../packages/person/index.js';
import {
  personRequestStatuses,
  requestMoveProblem,
  recordRequestMove,
  relayPerson,
  requestPerson,
} from '../../../../packages/link/index.js';
import { projectState } from '../../../view/index.js';
import {
  projectFit,
  pendingFit,
  fitFile,
} from '../../../../packages/blueprints/index.js';
import { verifiedPasskeyRowDecision } from '../../../../packages/person/index.js';
import {
  advanceItemSource,
  sourceAdvanceCASProblem,
} from '../../../../packages/sandbox/index.js';
import {
  proposeSentinel,
  decideSentinel,
  beginSentinelRun,
  finishSentinelRun,
} from '../../../../packages/sentinels/index.js';
import {
  flakeLedger,
  recordFlakeObservation,
} from '../../../../packages/flakes/index.js';
import {
  personProposals,
  personSigning,
  proposePersonMove,
  setPersonSigning,
  signedMoveProblem,
  exportedMeta,
  guardRestore,
} from '../../../../packages/person/index.js';
import { recordPublishFinding } from '../../../../packages/github/index.js';
import {
  landingWaivers,
  landingWaiverFor,
  waivedLandingProof,
} from '../../../../packages/landing/index.js';
import {
  prepareTrainLanding,
  prepareNativeTrainLanding,
} from '../../../../packages/landing/index.js';
import {
  sealItemPatchSubmit,
  sealItemPatchFollow,
} from '../../../../packages/items/index.js';
import {
  sealSourceAdvance,
  sealSourceAdvanceReturn,
} from '../../../../packages/sandbox/index.js';
import { computedReturnArgs } from '../../../../packages/landing/index.js';
import {
  requirePreparedComputedConflict,
  preflightComputedConflict,
  conflictValue,
} from '../../../../packages/landing/index.js';
import { validPresence } from '../../../../packages/person/index.js';
import { recordTrainLanding } from '../../../../packages/landing/index.js';
import {
  newRigorNotices,
  rigorNoticeText,
} from '../../../../packages/rigor/index.js';
import { DEFAULT_NEXT_STEPS } from '../../../../packages/state/index.js';
import * as landingEnvironment from '../../../../packages/landing/index.js';
import {
  deriveRigorCause,
  recordAutomaticRigorDrafts,
} from '../../../../packages/rigor/index.js';
import { normalizedDispatch } from '../../../../packages/sentinels/index.js';
import { rejectedWorkReturns } from '../../../../packages/sentinels/index.js';
import { guardLandingWrite } from '../../../../packages/store/index.js';

import { recordRowVerification as applyRowVerification } from '../../../../packages/spec/index.js';
import { decideSpecRevisions as applySpecRevisionDecisions } from '../../../../packages/spec/index.js';
import { draftSpecRow as applySpecRowDraft } from '../../../../packages/spec/index.js';
/** One native board composition root supplies connection-local runtime providers [C7]. */
import * as store from '../../../../packages/store/index.js';
import {
  addMilestone,
  editMilestone,
  editMilestoneItems,
  orderMilestoneItems,
  moveMilestone,
  removeMilestone,
  roadmap,
  shipMilestone,
} from '../../../../packages/store/index.js';
import { beginCommandPhase } from '../../../../packages/link/index.js';

import { boardEnginePorts } from '../../../../packages/store/index.js';
import {
  openBoardStore,
  requireRuntimePorts,
} from '../../../../packages/store/index.js';
import {
  guardStore,
  refreshStoreDeclarations,
} from '../../../../packages/store/index.js';
import {
  storeTriggers,
} from '../../../../packages/state/index.js';
import {
  atomic,
  logEvent,
} from '../../../../packages/store/index.js';
import {
  ensureProofCounters,
  currentProofCounters,
  proofCounter,
} from '../../../../packages/verify/index.js';
import { ensureHotIndexes } from '../../../../packages/store/index.js';
import { missingAdditiveIndexes } from '../../../../packages/store/index.js';
import { ensureAdditiveIndexes } from '../../../../packages/store/index.js';
import {
  configureBoardJournal,
  closeBoardWrites,
} from '../../../../packages/store/index.js';
import { sharedSchemaOwner } from '../../../../packages/store/index.js';
import { expectedBoardSchema } from '../../../../packages/store/index.js';
import { sharedSchemaDiagnostic } from '../../../../packages/store/index.js';
import { reportSharedSchema } from '../../../../packages/store/index.js';
import {
  boardStanding,
  migrate,
  recordSchemaStamp,
  reportDrift,
} from '../../../../packages/store/index.js';
import {
  openBoardReadOnly,
  openBoardForRead as readBoard,
  readEventLogVersion,
  systemClock,
} from '../../../../packages/store/index.js';
import { migrateEventLogVersion } from '../../../../packages/store/index.js';
import {
  boardNotWritable,
  boardBusyError,
} from '../../../../packages/store/index.js';
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
} from '../../../../packages/store/index.js';
import {
  appendRigorCounter,
  ensureRigorCounters,
} from '../../../../packages/rigor/index.js';
import {
  committedItemAuthors,
  twoTierReviews,
  strictReviewProblem,
  reviewPolicyChange,
  saveItemReviewPolicy,
} from '../../../../packages/verify/index.js';
import { holdUntilKind } from '../../../../packages/store/index.js';
import { forgetHoldMaintenance } from '../../../../packages/store/index.js';
import { rememberHoldCondition } from '../../../../packages/store/index.js';
import {
  STALE_STATE_ENGINE,
} from '../../../../packages/state/light.js';
import {
  readReceivedBoardState,
} from '../../../../packages/store/index.js';
import {
  verdictWithdrawalTarget,
} from '../../../../packages/verify/index.js';
import {
  computedConflictProblem,
} from '../../../../packages/landing/index.js';
import {
  firstRefusal,
} from '../../../../packages/store/index.js';
import {
  itemReviewPolicy,
} from '../../../../packages/verify/index.js';

import { normalizeReviewDefaults } from '../../../../packages/verify/index.js';

import * as self from './native.js';

/** The library's board surface: the store namespace plus the native operations this root composes [C7]. */
import { fileURLToPath } from 'node:url';
import { bindProofRunner } from '../../../../packages/verify/index.js';

// Rule-proof coverage compares committed runner bytes with this installed file; verify never imports the runner's cell.
bindProofRunner(fileURLToPath(new URL('../../../../packages/gate/src/io/run/tests.js', import.meta.url)));

const NATIVE_BOARD_NAMES = ['openBoardForRead', 'openBoard', 'draftSpecRow', 'decideSpecRevisions', 'recordRowVerification', 'advanceItemSource', 'proposeSentinel', 'decideSentinel', 'beginSentinelRun', 'finishSentinelRun', 'flakeLedger', 'recordFlakeObservation', 'flakeQuarantines', 'gateRuns', 'recordGateRun', 'personProposals', 'personSigning', 'proposePersonMove', 'setPersonSigning', 'recordPublishFinding', 'landingWaivers', 'landingWaiverFor', 'waivedLandingProof', 'recordTrainLanding'];
/** The milestone operations, each read through its live binding at call time (the same cyclic-load rule). */
const MILESTONE_READS = {
  addMilestone: () => addMilestone, editMilestone: () => editMilestone, editMilestoneItems: () => editMilestoneItems, orderMilestoneItems: () => orderMilestoneItems,
  moveMilestone: () => moveMilestone, removeMilestone: () => removeMilestone, roadmap: () => roadmap, shipMilestone: () => shipMilestone,
};
const libraryBoard = {};
/** Properties read through live bindings, so a cyclic first load never reads a store export before it exists. */
function libraryExport(name, read) { Object.defineProperty(libraryBoard, name, { enumerable: true, get: read }); }
/** The store names the library's public board has always exposed, each read from the store front door by name [C7]. */
const LIBRARY_STORE_NAMES = [
  'ACCEPT_REASON', 'BOARD_BUSY_TIMEOUT_MS', 'EVENT_LOG_VERSION', 'EVIDENCE_KINDS', 'FACT_KINDS', 'PERSON', 'REJECT_REASONS', 'ROUTES',
  'SCHEMA_VERSION', 'SIGNED_EVENT_LOG_VERSION', 'acceptCheck', 'acceptedVerdict', 'actOnActivity', 'activityDeliveryState', 'addItem',
  'agentActivity', 'agentAt', 'agentById', 'agentCreator', 'allShouts', 'answerDecision', 'answerTypedRequests', 'appendFact', 'applyRehomeItem',
  'applyRowDecisions', 'approveOutside', 'atomic', 'attachItemPatch', 'boardBusyError', 'boardId', 'buildOrder', 'canTake', 'canonicalFamily',
  'canonicalMilestoneTarget', 'checkedLandingCommit', 'claim', 'closeBoard', 'completeCheckBaseline', 'completeSubmitHandoff', 'coordinatorCheck',
  'coordinatorHolder', 'coordinatorOnly', 'createItemSlice', 'decisionAndEvidenceShouts', 'decisionAnswers', 'declareJob', 'editItem',
  'ensureCoordinator', 'escalate', 'events', 'eventsOfKinds', 'factReference', 'fileTypedRequest', 'finishLandingBatch', 'followItemPatches',
  'foreignBlockers', 'foreignDependencyStates', 'getItem', 'getShout', 'holdItem', 'holdLane', 'inbox', 'intakeOutside', 'itemById',
  'itemCheckAuthor', 'itemFiles', 'itemHold', 'itemPatchDigest', 'itemPatches', 'itemRedirect', 'itemThread', 'itemsInStatus', 'landingBatches',
  'landingFlakes', 'landingLeaseMove', 'landingLeaseState', 'landingTestDefects', 'landingWaiverCovers', 'landingWaiverKind', 'laneHold',
  'laneHolds', 'laneLeads', 'lastMoves', 'lineSettings', 'linkPublishRepair', 'listAgents', 'listItems', 'logEvent', 'maintainStaleState', 'merged',
  'milestonePriorities', 'milestones', 'moveItem', 'nextFor', 'nextSeatId', 'onlyCoordinator', 'openBoardReadOnly', 'openDecisions', 'openHandoff',
  'openRequests', 'passDecision', 'peekShouts', 'pendingRefreeze', 'pendingRefreezeProblem', 'planCompanion', 'postRigorNotices', 'prepareClaim',
  'prepareMergeOnlySubmit', 'prepareQueueSubmitHandoff', 'projectItemThreads', 'proofReceipts', 'queueSubmitHandoff', 'readBoardMembers',
  'readBoardSnapshot', 'readEventLogVersion', 'recentEvents', 'recentShouts', 'recordActivityDelivery', 'recordAttempt', 'recordExitProgress',
  'recordHealthFindings', 'recordJobRun', 'recordLandingBatch', 'recordLandingFlake', 'recordLandingTestDefect', 'recordLandingWaiver',
  'recordNextIdle', 'recordProofRun', 'recordRelayRefusal', 'recordRowDecisions', 'recordSharedUsage', 'recordSpecApprovalBaseline', 'recordUsage',
  'recordUsageBatch', 'refreeze', 'register', 'rehomeDestinationItemId', 'rehomeImport', 'rehomeItem', 'relatedItems', 'release', 'releaseItemHold',
  'releaseLane', 'removeItemPatch', 'reopen', 'requestCompanion', 'requireExitActive', 'reserveNextReview', 'reserveRehomeItemId', 'reserveReview',
  'reviewHolder', 'reviewOffer', 'reviewQueue', 'reviewQueueBreakdown', 'reviewReleaseCooldown', 'reviewReleaseNoteProblem', 'reviewerChecks',
  'rowDecisions', 'rowDrafts', 'rowVerifications', 'schemaMissing', 'seatEnrolled', 'seatFamily', 'seatLineage', 'setBarReady', 'setBoardMembers',
  'setItem', 'setLaneLead', 'setLineSetting', 'shout', 'shoutDetails', 'signBar', 'specApprovalBaseline', 'specApprovalBaselineExists',
  'startSubmitHandoff', 'stats', 'submit', 'submitInvariantEvents', 'systemClock', 'takeCoordinator', 'takeHandoff', 'typedRequests', 'unreadCount',
  'unverifiedSubmissions', 'validateItemAddition', 'validateItemEdit', 'verdictReviewProblem', 'verdictsFor', 'verify', 'withVerifierStanding',
  'withdraw', 'writeRefused',
];
/** The library names the store's write variants, which the door exports under a board_ prefix. */
const LIBRARY_WRITE_NAMES = { ensureCoordinator: 'board_ensureCoordinator', recordNextIdle: 'board_recordNextIdle' };
for (const name of LIBRARY_STORE_NAMES) libraryExport(name, () => store[LIBRARY_WRITE_NAMES[name] ?? name]);
for (const name of NATIVE_BOARD_NAMES) libraryExport(name, () => self[name]);
for (const [name, read] of Object.entries(MILESTONE_READS)) libraryExport(name, read);
export const board = Object.freeze(libraryBoard);
export { closeBoard } from '../../../../packages/store/index.js';

// The CLI's own next-step table, composed here from its state-cell defaults so opening a board never loads the CLI (#3906).
const NEXT_STEPS = withMoveNextSteps(DEFAULT_NEXT_STEPS);

/** Build immutable native capabilities once per connection, without a registry or cross-connection defaults. */
export function nativeBoardPorts() {
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

/** Freeze explicit provider bags without changing the function or canonical operation identities. */
function freezeRuntimePorts(ports) {
  requireRuntimePorts(ports);
  for (const name of ['nativePorts', 'enginePorts', 'guards', 'lifecycle', 'query', 'auth', 'sourceAdvanceReceipts', 'verification']) Object.freeze(ports[name]);
  return Object.freeze(ports);
}

/** Open the physical store with fully composed providers before migrations, guards or proof warming run. */
export function openBoard(file, clock = systemClock, { ports = nativeBoardPorts(), ...options } = {}) {
  return openBoardStore(file, clock, { ...options, ports: freezeRuntimePorts(ports) });
}

/** Give native read consumers the same capabilities without migrating or changing the light CLI read path. */
export function openBoardForRead(file, clock = systemClock, { ports = nativeBoardPorts(), connection = null } = {}) {
  const runtimePorts = freezeRuntimePorts(ports);
  const board = readBoard(file, clock, { connection });
  return board && Object.assign(board, { runtimePorts, nativePorts: runtimePorts.nativePorts, enginePorts: runtimePorts.enginePorts });
}

/** Execute an authenticated draft with the native composition root's explicit store ports. */
export function draftSpecRow(board, options) { return applySpecRowDraft(board, options, board.nativePorts); }

/** Execute a person revision decision without changing its native engine operation shape. */
export function decideSpecRevisions(board, options) { return applySpecRevisionDecisions(board, options, board.nativePorts); }

/** Record a row verdict through the same native query, transaction and event capabilities. */
export function recordRowVerification(board, options) { return applyRowVerification(board, options, board.nativePorts); }

/** Actual public operations remain owned by their providers; the raw board bridge expires with #1776. */
export { advanceItemSource } from '../../../../packages/sandbox/index.js';
export { proposeSentinel, decideSentinel, beginSentinelRun, finishSentinelRun } from '../../../../packages/sentinels/index.js';
export { flakeLedger, recordFlakeObservation } from '../../../../packages/flakes/index.js';
export { flakeQuarantines, gateRuns, recordGateRun } from '../../../../packages/flakes/index.js';
export { personProposals, personSigning, proposePersonMove, setPersonSigning } from '../../../../packages/person/index.js';
export { recordPublishFinding } from '../../../../packages/github/index.js';
export { landingWaivers, landingWaiverFor, waivedLandingProof } from '../../../../packages/landing/index.js';

export { recordTrainLanding } from '../../../../packages/landing/index.js';
