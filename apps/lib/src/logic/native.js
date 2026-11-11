/** @pullboard-module-loads apps/lib/src/logic/native/ports.js */
import { createRequire } from 'node:module';
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
import {
  openBoardStore,
  requireRuntimePorts,
  openBoardForRead as readBoard,
  systemClock,
} from '../../../../packages/store/index.js';

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

const requireModule = createRequire(import.meta.url);
let composed = null;
/** The package providers, loaded on the first call that needs them: a board that only reads never pays for the ~600 modules behind them [C7]. */
function providers() { return composed ??= requireModule('./native/ports.js'); }

/** Build immutable native capabilities once per connection, without a registry or cross-connection defaults. */
export function nativeBoardPorts() { return providers().nativeBoardPorts({ openBoard, openBoardForRead, draftSpecRow, decideSpecRevisions, recordRowVerification }); }

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

/** Serve a port bag from the connection's first read of it; a later assignment replaces it like any other property. */
function lazyPort(board, name, read) {
  Object.defineProperty(board, name, {
    enumerable: true,
    configurable: true,
    get: read,
    set(value) { Object.defineProperty(board, name, { value, enumerable: true, configurable: true, writable: true }); },
  });
}

/** Give native read consumers the same capabilities without migrating or changing the light CLI read path; the providers load when a consumer first reads a port. */
export function openBoardForRead(file, clock = systemClock, { ports = null, connection = null } = {}) {
  const board = readBoard(file, clock, { connection });
  if (!board) return board;
  let runtimePorts = null;
  const composedPorts = () => runtimePorts ??= freezeRuntimePorts(ports ?? nativeBoardPorts());
  lazyPort(board, 'runtimePorts', composedPorts);
  lazyPort(board, 'nativePorts', () => composedPorts().nativePorts);
  lazyPort(board, 'enginePorts', () => composedPorts().enginePorts);
  return board;
}

/** Execute an authenticated draft with the native composition root's explicit store ports. */
export function draftSpecRow(board, options) { return providers().applySpecRowDraft(board, options, board.nativePorts); }

/** Execute a person revision decision without changing its native engine operation shape. */
export function decideSpecRevisions(board, options) { return providers().applySpecRevisionDecisions(board, options, board.nativePorts); }

/** Record a row verdict through the same native query, transaction and event capabilities. */
export function recordRowVerification(board, options) { return providers().applyRowVerification(board, options, board.nativePorts); }

/** Actual public operations remain owned by their providers, which load at the first call; the raw board bridge expires with #1776. */
export function advanceItemSource(...args) { return providers().advanceItemSource(...args); }
export function proposeSentinel(...args) { return providers().proposeSentinel(...args); }
export function decideSentinel(...args) { return providers().decideSentinel(...args); }
export function beginSentinelRun(...args) { return providers().beginSentinelRun(...args); }
export function finishSentinelRun(...args) { return providers().finishSentinelRun(...args); }
export function flakeLedger(...args) { return providers().flakeLedger(...args); }
export function recordFlakeObservation(...args) { return providers().recordFlakeObservation(...args); }
export function flakeQuarantines(...args) { return providers().flakeQuarantines(...args); }
export function gateRuns(...args) { return providers().gateRuns(...args); }
export function recordGateRun(...args) { return providers().recordGateRun(...args); }
export function personProposals(...args) { return providers().personProposals(...args); }
export function personSigning(...args) { return providers().personSigning(...args); }
export function proposePersonMove(...args) { return providers().proposePersonMove(...args); }
export function setPersonSigning(...args) { return providers().setPersonSigning(...args); }
export function recordPublishFinding(...args) { return providers().recordPublishFinding(...args); }
export function landingWaivers(...args) { return providers().landingWaivers(...args); }
export function landingWaiverFor(...args) { return providers().landingWaiverFor(...args); }
export function waivedLandingProof(...args) { return providers().waivedLandingProof(...args); }
export function recordTrainLanding(...args) { return providers().recordTrainLanding(...args); }
