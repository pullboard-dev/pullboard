/** The board composition root: opens a real board with every package port composed, so packages and their tests open boards without an app [C7]. */
import { providers } from './src/io/providers.js';
import * as store from '../store/index.js';
import {
  addMilestone,
  editMilestone,
  editMilestoneItems,
  orderMilestoneItems,
  moveMilestone,
  removeMilestone,
  roadmap,
  shipMilestone,
} from '../store/index.js';

import { leaseEngine } from '../moves/light.js';
import { releaseEngine } from '../moves/light.js';
import { runTable } from '../moves/light.js';
import { withdrawEngine } from '../moves/light.js';
import { claimEngine } from '../moves/light.js';
import { submitEngine } from '../moves/light.js';
import { reopenEngine } from '../moves/light.js';
import { verifyEngine } from '../moves/light.js';
import { landingEngine } from '../moves/light.js';
import { pulledEngine } from '../moves/light.js';
import { reclaimEngine } from '../moves/light.js';
import { provideMoveTables } from '../store/index.js';
import { provideCoordinatorMilestoneRelease } from '../store/index.js';
import { coordinatorMilestoneRelease } from '../stats/light.js';

import * as self from './index.js';

// The store runs the move tables but never imports the moves cell, which reads the store; this root sees both and hands them over [C7].
provideMoveTables({ leaseEngine, releaseEngine, runTable, withdrawEngine, claimEngine, submitEngine, reopenEngine, verifyEngine, landingEngine, pulledEngine, reclaimEngine });
// The store answers a milestone ship through the stats release this root hands it, so the store needs no stats edge of its own [C7].
provideCoordinatorMilestoneRelease(coordinatorMilestoneRelease);

/** The library's board surface: the store namespace plus the native operations this root composes [C7]. */
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
  'SCHEMA_VERSION', 'SIGNED_EVENT_LOG_VERSION', 'acceptCheck', 'acceptedVerdict', 'actOnActivity', 'activityDeliveryState', 'addBlock', 'addItem',
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
  'readBoardSnapshot', 'readEventLogVersion', 'recentEvents', 'recentShouts', 'recordActivityDelivery', 'recordAttempt', 'recordCoordinatorUsage', 'recordExitProgress',
  'recordHealthFindings', 'recordJobRun', 'recordLandingBatch', 'recordLandingFlake', 'recordLandingTestDefect', 'recordLandingWaiver',
  'recordNextIdle', 'recordProofRun', 'recordRelayRefusal', 'recordRowDecisions', 'recordSharedUsage', 'recordSpecApprovalBaseline', 'recordUsage',
  'recordUsageBatch', 'refreeze', 'register', 'rehomeDestinationItemId', 'rehomeImport', 'rehomeItem', 'relatedItems', 'release', 'releaseItemHold',
  'releaseLane', 'removeItemPatch', 'reopen', 'requestCompanion', 'requireExitActive', 'reserveItem', 'reserveNextReview', 'reserveRehomeItemId', 'reserveReview',
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
export { closeBoard } from '../store/index.js';
/** The app above names its installed test runner through this door, so it imports one cell for the board and its proof binding [C7]. */
export { bindProofRunner } from '../verify/index.js';

export { bindBoardView } from './src/io/providers.js';

export { nativeBoardPorts, openBoard, openBoardForRead, draftSpecRow, decideSpecRevisions, recordRowVerification } from './src/io/open.js';

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
