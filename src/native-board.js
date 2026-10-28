import { advanceItemSource } from './source-advance.js';
import { proposeSentinel } from './sentinels.js';
import { decideSentinel } from './sentinels.js';
import { beginSentinelRun } from './sentinels.js';
import { finishSentinelRun } from './sentinels.js';
import { flakeLedger } from './flakes.js';
import { recordFlakeObservation } from './flakes.js';
import { flakeQuarantines } from './quarantine.js';
import { gateRuns } from './quarantine.js';
import { recordGateRun } from './quarantine.js';
import { personProposals } from './person-signing.js';
import { personSigning } from './person-signing.js';
import { proposePersonMove } from './person-signing.js';
import { setPersonSigning } from './person-signing.js';
import { recordPublishFinding } from './pr-findings.js';
import { landingWaivers } from './landing-waivers.js';
import { landingWaiverFor } from './landing-waivers.js';
import { waivedLandingProof } from './landing-waivers.js';
import { prepareTrainLanding } from './train-landing.js';
import { prepareNativeTrainLanding } from './train-landing.js';
import { sealItemPatchSubmit } from './item-patch-submit.js';
import { sealItemPatchFollow } from './item-patch-submit.js';
import { sealSourceAdvance } from './source-advance-origin.js';
import { computedReturnArgs } from './computed-conflict-return.js';
import { requirePreparedComputedConflict } from './computed-conflict-receipt.js';
import { preflightComputedConflict } from './computed-conflict-receipt.js';
import { signedMoveProblem } from './person-signing.js';
import { requireBound } from './quarantine.js';
import { requestMoveProblem } from './relay-requests.js';
import { recordRequestMove } from './relay-requests.js';
import { relayPerson } from './relay-requests.js';
import { requestPerson } from './relay-requests.js';
import { validPresence } from './person-presence.js';
import { recordTrainLanding } from './record-train-landing.js';
import {
  newRigorNotices,
  rigorNoticeText,
} from './rigor-notices.js';
import { sealSourceAdvanceReturn } from './source-advance-origin.js';
import { conflictValue } from './computed-conflict-receipt.js';
import { NEXT_STEPS } from './next-step-words.js';
import * as landingEnvironment from './landing-environment-guards.js';
import {
  deriveRigorCause,
  recordAutomaticRigorDrafts,
} from './rigor-auto.js';
import { normalizedDispatch } from './dispatch-health.js';
import { rejectedWorkReturns } from './rejected-work-return.js';
import { guardLandingWrite } from './board-landing-lease.js';

import { recordRowVerification as applyRowVerification } from './spec-verdicts.js';
import { decideSpecRevisions as applySpecRevisionDecisions } from './spec-revisions.js';
import { draftSpecRow as applySpecRowDraft } from './row-drafts.js';
/** One native board composition root supplies connection-local runtime providers [C7]. */
import * as store from './board.js';
import { sourceAdvanceCASProblem } from './source-advance.js';
import { beginCommandPhase } from './command-phase.js';
import { exportedMeta } from './person-signing.js';
import { guardRestore } from './person-signing.js';
import { receiptFields } from './gate-run-receipt.js';

import { boardReceiptStore } from './gate-run-receipt.js';
import { readGateReceipt } from './gate-run-receipt.js';
import { receiptBody } from './gate-run-receipt.js';
import { boardEnginePorts } from './board-engine-ports.js';
import {
  openBoardStore,
  requireRuntimePorts,
} from './board-store.js';
import {
  guardStore,
  refreshStoreDeclarations,
} from './board-store-guards.js';
import {
  storeTriggers,
} from './machine.js';
import {
  atomic,
  logEvent,
} from './board-event-log.js';
import {
  ensureProofCounters,
} from './proof-counters.js';
import {
  ensureHotIndexes,
  missingAdditiveIndexes,
  ensureAdditiveIndexes,
} from './board-hot.js';
import {
  configureBoardJournal,
  closeBoardWrites,
} from './board-write-lock.js';
import {
  sharedSchemaOwner,
  expectedBoardSchema,
  sharedSchemaDiagnostic,
  reportSharedSchema,
} from './board-schema.js';
import {
  boardStanding,
  migrate,
  recordSchemaStamp,
  reportDrift,
} from './board-migrate.js';
import {
  openBoardReadOnly,
  openBoardForRead as readBoard,
  readEventLogVersion,
  systemClock,
} from './board-read-open.js';
import {
  migrateEventLogVersion,
} from './board-event-log-migrate.js';
import {
  boardNotWritable,
  boardBusyError,
} from './board-access.js';
import {
  now,
  agentAt,
  itemById,
  itemCheckBaseline,
  events,
  acceptedVerdict,
  verdictReviewProblem,
  boardId,
} from './board-query.js';
import {
  appendRigorCounter,
  ensureRigorCounters,
} from './rigor-counters.js';
import {
  committedItemAuthors,
  twoTierReviews,
  strictReviewProblem,
  reviewPolicyChange,
  saveItemReviewPolicy,
} from './review-independence.js';
import {
  holdUntilKind,
  forgetHoldMaintenance,
  rememberHoldCondition,
} from './board-conditional-holds.js';
import {
  STALE_STATE_ENGINE,
} from './stale-state-engine.js';
import {
  readReceivedBoardState,
} from './board-link-state.js';
import {
  verdictWithdrawalTarget,
} from './verdict-withdrawal.js';
import {
  computedConflictProblem,
} from './computed-conflict-receipt.js';
import {
  firstRefusal,
} from './board-item-read.js';
import {
  itemReviewPolicy,
} from './review-policy.js';

export * as board from './board.js';
export { closeBoard } from './board-read-open.js';

/** Build immutable native capabilities once per connection, without a registry or cross-connection defaults. */
export function nativeBoardPorts() {
  const nativePorts = Object.freeze({
    sourceAdvanceCASProblem, beginCommandPhase, exportedMeta, guardRestore,
    newRigorNotices, rigorNoticeText, sealSourceAdvanceReturn, conflictValue, nextSteps: NEXT_STEPS, landingEnvironment, deriveRigorCause, recordAutomaticRigorDrafts, normalizedDispatch, rejectedWorkReturns,
    atomic, logEvent, rowDrafts: store.rowDrafts, rowDecisions: store.rowDecisions, PERSON: store.PERSON,
    recordRowDecisions: store.recordRowDecisions, now,
    committedItemAuthors, twoTierReviews, strictReviewProblem,
    holdUntilKind, forgetHoldMaintenance, rememberHoldCondition, staleStateEngine: STALE_STATE_ENGINE,
    addItem: store.addItem, agentById: store.agentById, appendFact: store.appendFact,
    getItem: store.getItem, reviewHolder: store.reviewHolder, readReceivedBoardState,
    listAgents: store.listAgents, verdictWithdrawalTarget, computedConflictProblem, firstRefusal,
    itemReviewPolicy, reviewPolicyChange, saveItemReviewPolicy,
    milestones: store.milestones, listItems: store.listItems, buildOrder: store.buildOrder,
    canTake: store.canTake, milestonePriorities: store.milestonePriorities, roadmap: store.roadmap, ROUTES: store.ROUTES,
  });
  const enginePorts = boardEnginePorts({
    recordTrainLanding, advanceItemSource, proposeSentinel, decideSentinel,
    beginSentinelRun, finishSentinelRun, flakeLedger, recordFlakeObservation,
    flakeQuarantines, gateRuns, recordGateRun, personProposals,
    personSigning, proposePersonMove, setPersonSigning, recordPublishFinding,
    landingWaivers, landingWaiverFor, waivedLandingProof, prepareTrainLanding,
    prepareNativeTrainLanding, sealItemPatchSubmit, sealItemPatchFollow, sealSourceAdvanceReturn,
    sealSourceAdvance, computedReturnArgs, requirePreparedComputedConflict, preflightComputedConflict,
    signedMoveProblem, requireBound, requestMoveProblem, recordRequestMove,
    relayPerson, requestPerson, validPresence
  });
  return Object.freeze({
    nativePorts, enginePorts, operations: enginePorts.operations, logEvent,
    sourceAdvanceReceipts: Object.freeze({ boardReceiptStore, readGateReceipt, receiptBody, receiptFields, guardLandingWrite }),

    verification: Object.freeze({ agentAt, itemById, itemCheckBaseline, events, acceptedVerdict, verdictReviewProblem, boardId, appendRigorCounter, ensureRigorCounters }),
    guards: Object.freeze({ guardStore, refreshStoreDeclarations, storeTriggers }),
    lifecycle: Object.freeze({ atomic, ensureProofCounters, ensureHotIndexes, missingAdditiveIndexes,
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
export function openBoardForRead(file, clock = systemClock, { ports = nativeBoardPorts() } = {}) {
  const runtimePorts = freezeRuntimePorts(ports);
  const board = readBoard(file, clock);
  return board && Object.assign(board, { runtimePorts, nativePorts: runtimePorts.nativePorts, enginePorts: runtimePorts.enginePorts });
}

/** Execute an authenticated draft with the native composition root's explicit store ports. */
export function draftSpecRow(board, options) { return applySpecRowDraft(board, options, board.nativePorts); }

/** Execute a person revision decision without changing its native engine operation shape. */
export function decideSpecRevisions(board, options) { return applySpecRevisionDecisions(board, options, board.nativePorts); }

/** Record a row verdict through the same native query, transaction and event capabilities. */
export function recordRowVerification(board, options) { return applyRowVerification(board, options, board.nativePorts); }

/** Actual public operations remain owned by their providers; the raw board bridge expires with #1776. */
export { advanceItemSource } from './source-advance.js';
export { proposeSentinel, decideSentinel, beginSentinelRun, finishSentinelRun } from './sentinels.js';
export { flakeLedger, recordFlakeObservation } from './flakes.js';
export { flakeQuarantines, gateRuns, recordGateRun } from './quarantine.js';
export { personProposals, personSigning, proposePersonMove, setPersonSigning } from './person-signing.js';
export { recordPublishFinding } from './pr-findings.js';
export { landingWaivers, landingWaiverFor, waivedLandingProof } from './landing-waivers.js';

export { recordTrainLanding } from './record-train-landing.js';
