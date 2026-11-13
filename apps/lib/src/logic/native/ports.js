/** @pullboard-module-loads apps/view/index.js */
import { createRequire } from 'node:module';
import { claimedItemRoot } from '../../../../../packages/items/index.js';
import { recordFamilyDeclareActivation } from '../../../../../packages/items/light.js';
import { withDerivedFamily } from '../../../../../packages/items/light.js';
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
import {
  MOVE_REGISTRY,
  MOVE_OPERATIONS,
  minimumMoveEngine,
  declaredMoveActor,
  withMoveNextSteps,
} from '../../../../../packages/moves/light.js';
import {
  sealItemPatchSubmit,
  sealItemPatchFollow,
} from '../../../../../packages/items/index.js';
import { DEFAULT_NEXT_STEPS } from '../../../../../packages/state/index.js';
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

import { boardEnginePorts } from '../../../../../packages/store/index.js';
import {
  guardStore,
  refreshStoreDeclarations,
  repairDrift,
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
  firstRefusal,
} from '../../../../../packages/store/index.js';
import {
  itemReviewPolicy,
} from '../../../../../packages/verify/index.js';

import { normalizeReviewDefaults } from '../../../../../packages/verify/index.js';

const requireModule = createRequire(import.meta.url);

/** One provider package, loaded on the first call that needs it and kept for the process. */
function onDemand(load) { let loaded = null; return () => loaded ??= load(); }

/** Named functions that load their package at their first call: a write that never calls one never pays for its modules [C7]. */
function deferred(load, names) { return Object.fromEntries(names.map(name => [name, { [name](...args) { return load()[name](...args); } }[name]])); }

const seal = onDemand(() => requireModule('../../io/seal.js'));
const healthPackage = onDemand(() => requireModule('../../../../../packages/health/index.js'));
const gatePackage = onDemand(() => requireModule('../../../../../packages/gate/index.js'));
const sandboxPackage = onDemand(() => requireModule('../../../../../packages/sandbox/index.js'));
const flakesPackage = onDemand(() => requireModule('../../../../../packages/flakes/index.js'));
const personPackage = onDemand(() => requireModule('../../../../../packages/person/index.js'));
const linkPackage = onDemand(() => requireModule('../../../../../packages/link/index.js'));
const blueprintsPackage = onDemand(() => requireModule('../../../../../packages/blueprints/index.js'));
const sentinelsPackage = onDemand(() => requireModule('../../../../../packages/sentinels/index.js'));
const githubPackage = onDemand(() => requireModule('../../../../../packages/github/index.js'));
const landingPackage = onDemand(() => requireModule('../../../../../packages/landing/index.js'));
const rigorPackage = onDemand(() => requireModule('../../../../../packages/rigor/index.js'));

const { sealOwnershipWait } = deferred(seal, ['sealOwnershipWait']);
const { claimHealthSnapshot, conditionalHoldFloor } = deferred(healthPackage, ['claimHealthSnapshot', 'conditionalHoldFloor']);
const { submitGateConfig, submitGatePlan, sealKnownMainAutofile, receiptFields, boardReceiptStore, readGateReceipt, receiptBody } = deferred(gatePackage, ['submitGateConfig', 'submitGatePlan', 'sealKnownMainAutofile', 'receiptFields', 'boardReceiptStore', 'readGateReceipt', 'receiptBody']);
const { policyAt, mainPolicy, frozenCheck, itemPolicy, requireTrunkMerge, submitHandoffBoardRoot, sealSubmitHandoffQueue, advanceItemSource, sourceAdvanceCASProblem, sealSourceAdvance, sealSourceAdvanceReturn } = deferred(sandboxPackage, ['policyAt', 'mainPolicy', 'frozenCheck', 'itemPolicy', 'requireTrunkMerge', 'submitHandoffBoardRoot', 'sealSubmitHandoffQueue', 'advanceItemSource', 'sourceAdvanceCASProblem', 'sealSourceAdvance', 'sealSourceAdvanceReturn']);
const { validateQuarantineProofIds, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, validateQuarantineVerdict, recordSealedGateRun, sealQuarantineVerdict, flakeQuarantines, gateRuns, recordGateRun, requireBound, flakeLedger, recordFlakeObservation } = deferred(flakesPackage, ['validateQuarantineProofIds', 'quarantineVerdictSnapshot', 'validateQuarantineGate', 'validateQuarantineLandingProof', 'validateQuarantineVerdict', 'recordSealedGateRun', 'sealQuarantineVerdict', 'flakeQuarantines', 'gateRuns', 'recordGateRun', 'requireBound', 'flakeLedger', 'recordFlakeObservation']);
const { personSigningPresentation, verifiedPasskeyRowDecision, personProposals, personSigning, proposePersonMove, setPersonSigning, signedMoveProblem, exportedMeta, guardRestore, validPresence } = deferred(personPackage, ['personSigningPresentation', 'verifiedPasskeyRowDecision', 'personProposals', 'personSigning', 'proposePersonMove', 'setPersonSigning', 'signedMoveProblem', 'exportedMeta', 'guardRestore', 'validPresence']);
const { personRequestStatuses, requestMoveProblem, recordRequestMove, relayPerson, requestPerson, beginCommandPhase } = deferred(linkPackage, ['personRequestStatuses', 'requestMoveProblem', 'recordRequestMove', 'relayPerson', 'requestPerson', 'beginCommandPhase']);
const { projectFit, pendingFit, fitFile } = deferred(blueprintsPackage, ['projectFit', 'pendingFit', 'fitFile']);
const { proposeSentinel, decideSentinel, beginSentinelRun, finishSentinelRun, normalizedDispatch, rejectedWorkReturns } = deferred(sentinelsPackage, ['proposeSentinel', 'decideSentinel', 'beginSentinelRun', 'finishSentinelRun', 'normalizedDispatch', 'rejectedWorkReturns']);
const { recordPublishFinding } = deferred(githubPackage, ['recordPublishFinding']);
const { landingWaivers, landingWaiverFor, waivedLandingProof, prepareTrainLanding, prepareNativeTrainLanding, computedReturnArgs, requirePreparedComputedConflict, preflightComputedConflict, conflictValue, recordTrainLanding, computedConflictProblem } = deferred(landingPackage, ['landingWaivers', 'landingWaiverFor', 'waivedLandingProof', 'prepareTrainLanding', 'prepareNativeTrainLanding', 'computedReturnArgs', 'requirePreparedComputedConflict', 'preflightComputedConflict', 'conflictValue', 'recordTrainLanding', 'computedConflictProblem']);
const { newRigorNotices, rigorNoticeText, deriveRigorCause, recordAutomaticRigorDrafts, appendRigorCounter, ensureRigorCounters } = deferred(rigorPackage, ['newRigorNotices', 'rigorNoticeText', 'deriveRigorCause', 'recordAutomaticRigorDrafts', 'appendRigorCounter', 'ensureRigorCounters']);
/** The landing checks the native board calls through nativePorts.landingEnvironment, loading landing at the first one. */
const landingEnvironment = Object.freeze(deferred(landingPackage, ['requireVerdict', 'requireBatch', 'requireRevision', 'requireTrunk', 'requireStoredBatch']));

let viewModule = null;
/** The view app, loaded on the first projection call: next and other board moves never pay for its modules [C7]. */
function view() { return viewModule ??= requireModule('../../../../view/index.js'); }
/** Project the board state through the view app, loading it at this call. */
function projectState(...args) { return view().projectState(...args); }
/** The agents the view shows as active, loading the view app at this call. */
function activeViewAgents(...args) { return view().activeViewAgents(...args); }
/** The view's proof summary, loading the view app at this call. */
function viewProofSummary(...args) { return view().viewProofSummary(...args); }

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

    verification: Object.freeze({ agentAt, itemById, itemCheckBaseline, events, acceptedVerdict, verdictReviewProblem, boardId, appendRigorCounter, ensureRigorCounters, withLocalSeatPresence }),
    guards: Object.freeze({ guardStore, refreshStoreDeclarations, repairDrift, storeTriggers }),
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
