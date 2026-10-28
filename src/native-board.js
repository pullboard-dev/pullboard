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
  const enginePorts = boardEnginePorts();
  return Object.freeze({
    nativePorts, enginePorts, operations: enginePorts.operations, logEvent,
    sourceAdvanceReceipts: Object.freeze({ boardReceiptStore, readGateReceipt, receiptBody, receiptFields }),
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
