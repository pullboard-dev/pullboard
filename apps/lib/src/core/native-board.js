import { sealOwnershipWait } from '../shell/ownership-wait-seal.js';
import { conditionalHoldFloor } from '../../../../packages/health/index.js';
import { recordFamilyDeclareActivation } from '../../../../src/family-declaration.js';
import { withDerivedFamily } from '../../../../src/family-declaration.js';
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
import { withLocalSeatPresence } from '../../../../packages/store/index.js';
import { policyAt } from '../../../../packages/sandbox/index.js';
import { mainPolicy } from '../../../../packages/sandbox/index.js';
import {
  frozenCheck,
  itemPolicy,
  requireTrunkMerge,
} from '../../../../packages/sandbox/index.js';
import { ENGINE_VERSION } from '../../../../src/engine-metadata.js';
import { PIPELINE_CAUSE_ENGINE } from '../../../../src/pipeline-cause-engine.js';
import { SUBMIT_HANDOFF_ENGINE } from '../../../../src/submit-handoff-engine.js';
import { firstRefusalDetail } from '../../../../packages/items/index.js';
import { itemPatchDigest } from '../../../../packages/items/index.js';
/** Supply current native engine thresholds without duplicating their values. */
function submitHandoffEngines() { return { current: ENGINE_VERSION, handoff: SUBMIT_HANDOFF_ENGINE }; }

/** Provide exact native engine thresholds for typed pipeline observations. */
function pipelineCauseEngines() { return { current: ENGINE_VERSION, pipeline: PIPELINE_CAUSE_ENGINE }; }

import { submitHandoffBoardRoot } from '../../../../src/submit-handoff-origin.js';
import { sealSubmitHandoffQueue } from '../../../../src/submit-handoff-seal.js';
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
} from '../../../../src/move-registry.js';
import {
  activeViewAgents,
  viewProofSummary,
} from '../../../../src/view-state-summary.js';
import { personSigningPresentation } from '../../../../packages/person/index.js';
import {
  personRequestStatuses,
  requestMoveProblem,
  recordRequestMove,
  relayPerson,
  requestPerson,
} from '../../../../packages/link/index.js';
import { projectState } from '../../../../src/serve.js';
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
} from '../../../../src/item-patch-submit.js';
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
import { NEXT_STEPS } from '../../../../src/next-step-words.js';
import * as landingEnvironment from '../../../../packages/landing/index.js';
import {
  deriveRigorCause,
  recordAutomaticRigorDrafts,
} from '../../../../packages/rigor/index.js';
import { normalizedDispatch } from '../../../../packages/sentinels/index.js';
import { rejectedWorkReturns } from '../../../../packages/sentinels/index.js';
import { guardLandingWrite } from '../../../../src/board-landing-lease.js';

import { recordRowVerification as applyRowVerification } from '../../../../packages/spec/index.js';
import { decideSpecRevisions as applySpecRevisionDecisions } from '../../../../packages/spec/index.js';
import { draftSpecRow as applySpecRowDraft } from '../../../../packages/spec/index.js';
/** One native board composition root supplies connection-local runtime providers [C7]. */
import * as store from '../../../../src/board.js';
import {
  addMilestone,
  editMilestone,
  editMilestoneItems,
  orderMilestoneItems,
  moveMilestone,
  removeMilestone,
  roadmap,
  shipMilestone,
} from '../../../../src/board-milestones.js';
import { beginCommandPhase } from '../../../../packages/link/index.js';

import { boardEnginePorts } from '../../../../src/board-engine-ports.js';
import {
  openBoardStore,
  requireRuntimePorts,
} from '../../../../src/board-store.js';
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
import {
  ensureHotIndexes,
  missingAdditiveIndexes,
  ensureAdditiveIndexes,
} from '../../../../src/board-hot.js';
import {
  configureBoardJournal,
  closeBoardWrites,
} from '../../../../packages/store/index.js';
import {
  sharedSchemaOwner,
  expectedBoardSchema,
  sharedSchemaDiagnostic,
  reportSharedSchema,
} from '../../../../src/board-schema.js';
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
import {
  migrateEventLogVersion,
} from '../../../../src/board-event-log-migrate.js';
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
import {
  holdUntilKind,
  forgetHoldMaintenance,
  rememberHoldCondition,
} from '../../../../src/board-conditional-holds.js';
import {
  STALE_STATE_ENGINE,
} from '../../../../src/stale-state-engine.js';
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

import * as self from './native-board.js';
import * as milestoneOperations from '../../../../src/board-milestones.js';

/** The library's board surface: the store namespace plus the native operations this root composes [C7]. */
const NATIVE_BOARD_NAMES = ['openBoardForRead', 'openBoard', 'draftSpecRow', 'decideSpecRevisions', 'recordRowVerification', 'advanceItemSource', 'proposeSentinel', 'decideSentinel', 'beginSentinelRun', 'finishSentinelRun', 'flakeLedger', 'recordFlakeObservation', 'flakeQuarantines', 'gateRuns', 'recordGateRun', 'personProposals', 'personSigning', 'proposePersonMove', 'setPersonSigning', 'recordPublishFinding', 'landingWaivers', 'landingWaiverFor', 'waivedLandingProof', 'recordTrainLanding'];
const MILESTONE_NAMES = ['addMilestone', 'editMilestone', 'editMilestoneItems', 'orderMilestoneItems', 'moveMilestone', 'removeMilestone', 'roadmap', 'shipMilestone'];
const libraryBoard = {};
/** Properties read through live bindings, so a cyclic first load never reads a store export before it exists. */
function libraryExport(name, read) { Object.defineProperty(libraryBoard, name, { enumerable: true, get: read }); }
for (const name of Reflect.ownKeys(store)) if (typeof name === 'string') libraryExport(name, () => store[name]);
for (const name of NATIVE_BOARD_NAMES) libraryExport(name, () => self[name]);
for (const name of MILESTONE_NAMES) libraryExport(name, () => milestoneOperations[name]);
export const board = Object.freeze(libraryBoard);
export { closeBoard } from '../../../../packages/store/index.js';

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
    conditionalHoldFloor,
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
    presentation: Object.freeze({ openBoard, verifiedPasskeyRowDecision, pendingFit, projectFit, projectState, personRequestStatuses, personSigningPresentation, activeViewAgents, viewProofSummary, fitFile }),
    sourceAdvanceReceipts: Object.freeze({ boardReceiptStore, readGateReceipt, receiptBody, receiptFields, guardLandingWrite }),

    verification: Object.freeze({ agentAt, itemById, itemCheckBaseline, events, acceptedVerdict, verdictReviewProblem, boardId, appendRigorCounter, ensureRigorCounters }),
    guards: Object.freeze({ guardStore, refreshStoreDeclarations, storeTriggers }),
    lifecycle: Object.freeze({ atomic, normalizeReviewDefaults: board => normalizeReviewDefaults(board, { logEvent }), ensureProofCounters, ensureHotIndexes, missingAdditiveIndexes,
      ensureAdditiveIndexes, configureBoardJournal, closeBoardWrites }),
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
