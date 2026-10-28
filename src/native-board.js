/** One native board composition root supplies connection-local runtime providers [C7]. */
import * as store from './board.js';
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
} from './board-query.js';
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
} from './conditional-holds.js';
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
} from './claims.js';
import {
  itemReviewPolicy,
} from './review-policy.js';

export * as board from './board.js';
export { closeBoard } from './board-read-open.js';

/** Build immutable native capabilities once per connection, without a registry or cross-connection defaults. */
export function nativeBoardPorts() {
  const nativePorts = Object.freeze({
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
  const enginePorts = boardEnginePorts(store);
  return Object.freeze({
    nativePorts, enginePorts, operations: enginePorts.operations, logEvent,
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
  for (const name of ['nativePorts', 'enginePorts', 'guards', 'lifecycle', 'query', 'auth']) Object.freeze(ports[name]);
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

/** Supply native providers once when a writable board is opened; only values enter sealed moves. */
function boardEnginePorts(boardApi) {
  if (!boardApi || typeof boardApi.openBoard !== 'function') throw new TypeError('The native root must supply its canonical board API.');
  return Object.freeze({ store: boardApi, withSeatPresence, registry: MOVE_REGISTRY, operations: MOVE_OPERATIONS,
    minimumOperationEngine: minimumMoveEngine, sealSourceAdvanceReturn, sealSourceAdvance,
    computedReturnArgs, requirePreparedComputedConflict, preflightComputedConflict, boundProofReceipt,
    requireOutsideReceipt, signedMoveProblem, requireCoordinatorHold, requireBound,
    requestMoveProblem, recordRequestMove, relayPerson, requestPerson,
    personAuthority, relayMoveActor, relaySenderProblem, validRelaySender });
}
