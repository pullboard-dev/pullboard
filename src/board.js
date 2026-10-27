import { REFERENCE_ENGINE } from './reference-engine.js';
import { validateReferences } from './reference-authors.js';
import {
  submissionItemValues,
  recordSubmissionEvent,
} from './submission-record.js';
import { foreignBlockers } from './cross-repo-dependencies.js';
import * as itemDependencies from './item-dependencies.js';
import { AGENT_GRANT_ENGINE } from './agent-grant-engine.js';
import { submitAdmission as checkedSubmitAdmission } from './submit-admission.js';
import * as computedConflictEvidence from './computed-conflict-receipt.js';
import { reopenAuthority } from './reopen-authority.js';
import { applyLaneLead } from './lane-lead-policy.js';
import { applyHealthFindings } from './board-health.js';
import {
  isLaneEscalation,
  laneLeads,
  leadOwnsDecision,
  routeLaneMessage,
} from './lane-lead.js';
export { laneLeads };

import { companionPlan } from './companion.js';
import { applyCompanionRequest } from './companion.js';
export { readBoardMembers, setBoardMembers } from './board-members.js';
import { heartbeatSeat } from './seat-presence.js';
import * as itemDecisions from './item-decision-queue.js';
import * as activityDeliveryStore from './activity-delivery-store.js';
import { requireFactKind } from './item-notes.js';
import {
  criticalPathEnabled,
  criticalPathOrder,
  remainingPaths,
} from './critical-path-order.js';
import { activityNewsFlag } from './activity-news.js';
import { migrateEventLogVersion } from './board-event-log-migrate.js';
import {
  configureBoardJournal,
  closeBoardWrites,
} from './board-write-lock.js';
import {
  focusOrder,
  focusReasons,
  milestoneFocus,
} from './focus-milestone.js';
import { answerProvenance } from './decision-origin.js';
import { ensureProofCounters } from './proof-counters.js';
import { correctedNoVerdictReopen } from './reopen-history.js';
import {
  getShout,
  milestones,
  openRequests,
  pendingRefreeze,
  pendingRefreezeProblem,
  milestonePriorities,
} from './board-read-auxiliary.js';
export {
  getShout,
  allShouts,
  shoutDetails,
  decisionAnswers,
  openRequests,
  pendingRefreeze,
  pendingRefreezeProblem,
  milestonePriorities,
  peekShouts,
  projectItemThreads,
  milestones,
  unverifiedSubmissions,
} from './board-read-auxiliary.js';
export { openHandoff, takeHandoff } from './handoff.js';
import { LAND_COLLISION_ENGINE } from './landing-collision-engine.js';
import * as capacity from './line-capacity-board.js';
import {
  lineOrderEnabled,
  lineBuildOrder,
  reviewerScarcity,
  barReadyForOrder,
} from './line-order.js';
export { lineSettings, setLineSetting } from './line-settings.js';

import {
  applyOutsideIntake,
  approveOutside as applyOutsideApproval,
} from './outside-store.js';
import {
  outsideSandboxProblem,
  outsideBuildProblem,
  outsideSource,
  requireOutsideOwner,
  saveOutsideSource,
} from './outside-source.js';
import { validateItemDependencies } from './board-item-dependencies.js';
import { validateRehomeCheck } from './board-rehome.js';
import { applyRehomeItem as applyRehomeRecord } from './item-rehome.js';
export {
  itemRedirect,
  rehomeDestinationItemId,
  rehomeImport,
  rehomeItem,
  reserveRehomeItemId,
} from './board-rehome.js';
import { FILE_GROWTH_NOTICE_ENGINE } from './file-growth-notice-engine.js';
import {
  recordBarRevision,
  barReadyProblem,
} from './bar-readiness.js';
import { barCheckFactFields } from './bar-check.js';
export { setBarReady, signBar } from './bar-readiness.js';
import {
  coordinatorCheck,
  normalizeCheckBaseline,
  saveCheckBaseline,
} from './item-check-baseline.js';
export { coordinatorCheck, completeCheckBaseline, itemCheckAuthor } from './item-check-baseline.js';
import {
  closeBoard,
  openBoardForRead,
  openBoardReadOnly,
  readEventLogVersion,
  systemClock,
} from './board-read-open.js';
import * as verdictWithdrawal from './verdict-withdrawal.js';
import {
  BOARD_BUSY_TIMEOUT_MS,
  EVENT_LOG_VERSION,
  SCHEMA,
  SCHEMA_DIGEST,
  SCHEMA_VERSION,
} from './board-schema-source.js';
import {
  PERSON,
  now,
  isHeld,
  current,
  reviewReleasesSinceSubmit,
  boardId,
  itemById,
  getItem,
  listItems,
  itemsInStatus,
  reviewHolder,
  reviewQueueBreakdown,
  reviewQueue,
  openDecisions,
  unreadCount,
  events,
  itemThread,
  itemHold,
  laneHold,
  laneHolds,
  rowDecisions,
  UNREAD_SQL,
} from './board-query.js';

import { ITEM_SHOUT_ENGINE } from './item-shout-engine.js';
import {
  COORDINATION_SHOUT,
  itemShoutTarget,
  itemShoutReader,
  shoutItemId,
  unreadShoutBindings,
} from './shout-audience.js';
import { recordVerdict } from './verdict-assurance.js';
import {
  mergeOnlyBasis,
  mergeOnlyProblem,
} from './merge-only-verdict.js';
import { prepareMergeOnlySubmit } from './merge-only-submit.js';
import { MERGE_ONLY_VERDICT_ENGINE } from './merge-only-verdict-engine.js';
import {
  atomic,
  logEvent,
} from './board-event-log.js';
export { atomic, logEvent };
/**
 * The board (B1–B7, V1–V8, R1–R3): items, claims, submissions, verdicts and shouts in one SQLite
 * file in the git common dir, so every worktree sees the same board and nothing is committed.
 *
 * Every move is one immediate transaction (B2), so two agents can never claim the same item, and
 * every move lands in an append-only event log (R2). The caller supplies what only git and the
 * spec know: the commit, the verifier's checkout, the frozen criterion.
 */
import {
  verdictReviewProblem,
  verdictsFor,
  acceptedVerdict,
  checkedLandingCommit,
} from './verdict-reviews.js';
export { verdictReviewProblem, verdictsFor, acceptedVerdict, checkedLandingCommit };
export { landingTestDefects, recordLandingTestDefect } from './landing-test-defects.js';
export { landingLeaseMove, landingLeaseState } from './landing-lease.js';
import { guardLandingWrite } from './landing-lease.js';
import {
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  sharedSchemaOwner,
  expectedBoardSchema,
  sharedSchemaDiagnostic,
  reportSharedSchema,
} from './board-schema.js';
import { DatabaseSync } from 'node:sqlite';
import {
  boardNotWritable,
  boardBusyError,
} from './board-access.js';
import { ensureHotIndexes } from './board-hot.js';
import { guardStore } from './board-store-guards.js';
import { refreshStoreDeclarations } from './board-store-guards.js';
import { ensureAdditiveIndexes } from './board-hot.js';
import { missingAdditiveIndexes } from './board-hot.js';
import {
  factIdentityExists,
  requireFactIdentityIndexes,
} from './fact-identity.js';
import { NEXT_STEPS } from './next-step-words.js';
export { boardBusyError } from './board-access.js';
import {
  boardStanding,
  migrate,
  recordSchemaStamp,
  reportDrift,
} from './board-migrate.js';
export { schemaMissing, writeRefused } from './board-migrate.js';
import { checkRouted } from './item-routing.js';
import {
  itemFiles,
  itemFileCollisions,
  addedFileCollisions,
} from './item-files.js';
export { itemFiles };
import { COORDINATOR } from './config.js';
import {
  manualLandingFailure,
  manualLandingFailureQuoted,
  firstRefusal,
  firstRefusalProblem,
  firstRefusalReason,
  firstRefusalDetail,
  tellFirstRefusal,
} from './claims.js';
import {
  ENGINE_VERSION,
  QUOTED_LANDING_FAILURE_ENGINE,
  REOPEN_FIRST_REFUSAL_ENGINE,
  VERDICT_REVIEW_ENGINE,
  MILESTONE_RANK_ENGINE,
  GUARDS,
  IN_STATE,
  MOVES,
  STATES,
  UNKNOWN_MOVE,
  VERIFIER_STANDING_ENGINE,
  effectiveGuards,
  storeTriggers,
} from './machine.js';
import { LOCAL_LANDING_ENGINE } from './land-engine.js';
import { SPEC_APPROVAL_ENGINE } from './spec-approval-engine.js';
import { SPEC_REVISION_ENGINE } from './spec-revision-engine.js';
import {
  markAppliedRevisions,
  validRevisionApproval,
} from './spec-revisions.js';
export { decideSpecRevisions } from './spec-revisions.js';
import * as landingEnvironment from './landing-environment-guards.js';
import { Refused } from './refused.js';
import { saveJoinedSession } from './parent-session.js';
import {
  itemAuthorProblem,
  retainedVerifierIdentityProblem,
} from './item-authors.js';
import {
  ROUTES,
  canTake,
  recordRejectedItemRoute,
} from './route-escalation.js';
export { ROUTES, canTake };
import {
  agentAt,
  listAgents,
  newSeatId,
  routeOf,
  saveAgentModel,
  seatLineage,
} from './seats.js';
import {
  newRigorNotices,
  rigorNoticeText,
} from './rigor-notices.js';
import { RIGOR_NOTICE_ENGINE } from './rigor-source.js';
import { RIGOR_AUTO_ENGINE } from './rigor-auto-engine.js';
import {
  milestoneRanks,
  workOrderCompare,
} from './work-order.js';
import {
  deriveRigorCause,
  recordAutomaticRigorDrafts,
} from './rigor-auto.js';
import {
  causeProblem,
  requireNeverAgain,
} from './rigor.js';
import { barCorrectionFields } from './bar-corrections.js';
import {
  conflictDetail,
  conflictNote,
  conflictProblem,
  returnedHeadNotice,
} from './trunk-conflict.js';
import { factReference } from './fact-reference.js';
import {
  factFromEvent,
  requestAnswerRefusal,
  tellAnswerImplications,
  tellFactImplications,
  tellVerdictImplications,
} from './implies.js';
import {
  landingFlakes,
  landingWaiverCovers,
  landingWaiverKind,
} from './landing-exceptions.js';
import { parseSpec } from './spec.js';
import {
  invariantEvidence,
  preserveInvariantEvidence,
  validateLandingBatch,
  validateLandingRevision,
  submissionProof,
  SUBMISSION_PROOF_ENGINE,
} from './submit-invariants.js';
import { landingBatches } from './landing-batch-history.js';
import {
  NATIVE_FLAKE_ENGINE,
  carriesFlakeDiagnostics,
} from './flake-engine.js';
export { landingFlakes, landingWaiverCovers, landingWaiverKind };
export { landingWaivers, landingWaiverFor, waivedLandingProof } from './landing-waivers.js';
export { acceptCheck } from './check-accept.js';
export { declareJob, recordJobRun } from './recurring-jobs.js';
export { proposeSentinel, decideSentinel, beginSentinelRun, finishSentinelRun } from './sentinels.js';
export { flakeLedger, recordFlakeObservation } from './flakes.js';
export { flakeQuarantines, gateRuns, recordGateRun } from './quarantine.js';
export { personProposals, personSigning, proposePersonMove, setPersonSigning } from './person-signing.js'; // Signed person moves [E22].
export { proofReceipts, recordProofRun } from './proof-receipts.js';
import { refuseLongShout } from './proof-receipts.js';
import { PROOF_RUN_ENGINE } from './proof-run-engine.js';
export { recordPublishFinding } from './pr-findings.js';
/** The seat readers live in seats.js; the board re-exports them so `store.*` callers keep one import. */
export { agentAt, agentById, agentCreator, coordinatorHolder, listAgents, nextSeatId, seatEnrolled, seatLineage, takeCoordinator, withVerifierStanding } from './seats.js';

export const ACCEPT_REASON = 'CRITERION_MET';
export { PERSON } from './board-query.js';

export { EVENT_LOG_VERSION, SIGNED_EVENT_LOG_VERSION } from './board-schema-source.js';

export { BOARD_BUSY_TIMEOUT_MS } from './board-schema-source.js';

const REVIEW_RELEASE_COOLDOWN_MS = 60 * 60 * 1000;

export const REJECT_REASONS = [
  'TEST_FAILURE',
  'BEHAVIOR_MISMATCH',
  'INSUFFICIENT_EVIDENCE',
  'STALE_HEAD',
  'OTHER',
];

export { systemClock } from './board-read-open.js';

export { openBoardForRead } from './board-read-open.js';

export { openBoardReadOnly } from './board-read-open.js';
/**
 * Open, or create, the board at `file`. Tests pass `:memory:`.
 *
 * The busy timeout comes first, so a second process opening the board at the same moment waits for
 * the lock instead of failing.
 *
 * @param {string} file
 * @param {{ now: () => Date }} [clock]
 * @param {{ isMain?: boolean, onDiagnostic?: (message: string) => void, writeContext?: {command?:string, seat?:string, path?:string}, gitRoot?: string }} [options] Only main upgrades schema; gitRoot is a local verification port, never replicated metadata.
 * @returns {{ db: DatabaseSync, clock: { now: () => Date } }}
 */
export function openBoard(file, clock = systemClock, { isMain, onDiagnostic, writeContext, gitRoot } = {}) {
  isMain = sharedSchemaOwner(file, isMain);
  if (file !== ':memory:' && isMain === false) {
    let boardVersion = 0;
    let logVersion = 0;
    if (existsSync(file)) {
      const startedAt = Date.now();
      let current;
      try {
        current = openBoardReadOnly(file);
        boardVersion = current.prepare('PRAGMA user_version').get().user_version;
        logVersion = readEventLogVersion(current);
      } catch (error) {
        throw boardNotWritable(file, boardBusyError(file, startedAt, error));
      } finally {
        current?.close();
      }
      if (SCHEMA_VERSION > boardVersion) {
        throw new Refused(
          'UNMERGED_SCHEMA',
          `this worktree expects board schema ${SCHEMA_VERSION}, newer than the shared board's version ${boardVersion}; merge this code into the main checkout first, or test it against a throwaway board`,
        );
      }
      if (EVENT_LOG_VERSION > logVersion) {
        throw new Refused('UNMERGED_SCHEMA', `this worktree expects event log ${EVENT_LOG_VERSION}, newer than the shared board's version ${logVersion}; merge this code into the main checkout first, or test it against a throwaway board`);
      }
    }
  }
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const startedAt = Date.now();
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec(`PRAGMA busy_timeout = ${BOARD_BUSY_TIMEOUT_MS}`);
    if (file !== ':memory:' && isMain !== false) configureBoardJournal(db, writeContext);
    const board = { db, clock, writeContext, gitRoot, onDiagnostic };
    let warmCounters = true;
    if (isMain !== false || file === ':memory:') {
      // Migrate and audit only a board whose version is behind; a drifted shape is reported and left alone (#1047).
      let standing = boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION, readEventLogVersion(db) < EVENT_LOG_VERSION);
      if (standing === 'behind' || standing === 'unstamped') atomic(board, () => {
        if (standing === 'behind') {
          migrateEventLogVersion(db);
          migrate(db);
          ensureHotIndexes(db);
          db.prepare('INSERT OR IGNORE INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run('board_id', randomBytes(16).toString('hex'));
          guardStore(board);
        }
        recordSchemaStamp(db, SCHEMA_DIGEST);
      });
      if (refreshStoreDeclarations(board)) standing = boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION);
      // Index-only upgrades keep the data version/digest unchanged. Install and restamp together;
      // drifted or read-only stores never take this path, and old clients accept the resulting stamp.
      if (standing !== 'drifted' && missingAdditiveIndexes(db)) atomic(board, () => {
        if (boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION) !== 'current') return;
        ensureAdditiveIndexes(db);
        recordSchemaStamp(db, SCHEMA_DIGEST);
      });
      if (standing === 'drifted') { warmCounters = false; reportDrift(file, onDiagnostic); }
    } else {
      // Read compatibility before any local effect; persistent schema belongs to trunk alone.
      readEventLogVersion(db);
      reportSharedSchema(file, sharedSchemaDiagnostic(db, expectedBoardSchema(SCHEMA, migrate, storeTriggers)), onDiagnostic);
    }
    guardMoves(board);
    // Writable commands catch up old writers or missing local projections once. Read-only open
    // never calls this path; drifted stores remain untouched, and invalid history stays invalid.
    // Proof warming also preserves the Rigor projection, including after a proof-cache rebuild.
    if (warmCounters) atomic(board, () => ensureProofCounters(board));
    return board;
  } catch (error) {
    try { db?.close(); if (db) closeBoardWrites(db); } catch { /* Preserve the opening failure when SQLite cleanup also fails. */ }
    throw boardNotWritable(file, boardBusyError(file, startedAt, error));
  }
}

/**
 * Make this connection refuse any change to an item's status that does not come through moveItem
 * (M1). A TEMP trigger, which lives only in this process's connection, lets the status column
 * change only while moveItem holds a token in a TEMP table, so a status written anywhere else in
 * this code, however it is spelled, is refused by SQLite itself. Recursive triggers stay on, so a
 * REPLACE INTO, which deletes the old row first, meets the board file's own delete trigger. An
 * agent's own connection never sees these TEMP objects; the board file's triggers (M3) govern it.
 *
 * @param {any} board
 */
function guardMoves(board) {
  board.db.exec(`
    PRAGMA recursive_triggers = ON;
    CREATE TEMP TABLE IF NOT EXISTS moving (token INTEGER);
    CREATE TEMP TRIGGER IF NOT EXISTS status_through_moves BEFORE UPDATE OF item_status ON main.item
    WHEN NOT EXISTS (SELECT 1 FROM temp.moving)
    BEGIN SELECT RAISE(ABORT, 'STATUS_OUTSIDE_MOVE: only moveItem in src/board.js changes an item''s status'); END;
  `);
}

export { SCHEMA_VERSION } from './board-schema-source.js';

export { readEventLogVersion } from './board-read-open.js';


export { boardId } from './board-query.js';

export { closeBoard } from './board-read-open.js';

/** Log an authenticated relay refusal without making an item, shout or verdict move [H2,H16]. */
export function recordRelayRefusal(board, { by, sequence, kind, operation, actor, code, itemId = null, person = null }) {
  logEvent(board, by, 'relay_refused', itemId, { sequence, kind, operation, actor, code, ...(person ? { person } : {}) }); // who tried it, from engine 73 [E3]
}

export { itemById } from './board-query.js';

/**
 * Write some of an item's fields, and its updated time. Field names come from this module only.
 *
 * @param {any} board
 * @param {number} id
 * @param {Record<string, string | number | null>} fields
 */
function setItem(board, id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((key) => `${key} = ?`).join(', ');
  board.db
    .prepare(`UPDATE item SET ${sets}, item_updated_at = ? WHERE item_id = ?`)
    .run(...keys.map((key) => fields[key]), now(board), id);
}

/** Link a fresh neutral CI repair to its merged original without changing either status [B2,R3]. */
export function linkPublishRepair(board, { agentId, item, repair }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator links publication CI repairs');
  const original = getItem(board, item);
  const child = getItem(board, repair);
  if (!original.item_merged_commit || original.item_status !== 'verified' || child.item_status !== 'open' ||
      child.item_created_by !== COORDINATOR || child.item_parent_id !== null || child.item_lane !== original.item_lane || item === repair) {
    throw new Refused('PUBLISH_FINDING', 'link only a new neutral coordinator repair to its merged original');
  }
  setItem(board, repair, { item_parent_id: item });
}

/**
 * Register a worktree as an agent (B3): the main checkout as the one coordinator, any other
 * worktree as the next agent in its lane (`web-1`, `web-2`, ...), on a route: the tier of model
 * behind it, which decides the items it may take (B13). The optional family is free text supplied
 * by the agent; the board neither names nor infers it. Registering again preserves the agent id;
 * explicitly supplied family and model values update their declarations, while omission preserves them.
 *
 * From engine 35 a new seat records the seat that created it (`createdBy`: an agent id, or
 * `machine` for a join no seat made), so a linked board can tell a builder's own seats from
 * independent verifiers (#579). A creator may name the new seat (`id`, the lane's next form) when
 * the relay already issued a token for the next name; ids then skip taken names.
 *
 * @param {any} board
 * @param {{ lane: string, path: string, route?: string, family?: string | null, model?: string | null, parent?: string | null, session?: string | null, createdBy?: string, id?: string }} who
 * @returns {string} The agent's id.
 */
export function register(board, who) {
  let { lane, path, route = 'strong', family, model, createdBy, id: named } = who;
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (engine < 8) model = undefined;
  if (engine < VERIFIER_STANDING_ENGINE) { createdBy = undefined; named = undefined; }
  checkRoute(route);
  if (lane === COORDINATOR && route !== 'strong') {
    throw new Refused('BAD_ROUTE', 'the coordinator plans, merges and verifies; it is always strong');
  }
  return atomic(board, () => {
    const existing = agentAt(board, path);
    if (existing) {
      if (existing.agent_lane !== lane || existing.agent_route !== route) {
        throw new Refused(
          'ALREADY_JOINED',
          `this worktree is ${existing.agent_id} in the ${existing.agent_lane} lane, routed ${existing.agent_route}; use another worktree for ${lane} routed ${route}`,
        );
      }
      saveJoinedSession(board, existing.agent_id, who);
      if (family !== undefined && family !== existing.agent_family) {
        board.db.prepare('UPDATE agent SET agent_family = ? WHERE agent_id = ?').run(family, existing.agent_id);
        logEvent(board, existing.agent_id, 'family', null, { family });
      }
      if (model !== undefined && model !== existing.agent_model) {
        saveAgentModel(board, existing.agent_id, model);
        logEvent(board, existing.agent_id, 'model', null, { model: model ?? 'unknown' });
      }
      return existing.agent_id;
    }
    const { total } = board.db
      .prepare('SELECT COUNT(*) AS total FROM agent WHERE agent_lane = ?')
      .get(lane);
    if (lane === COORDINATOR && total > 0) {
      throw new Refused('ONE_COORDINATOR', 'the coordinator is the main checkout; it already has one');
    }
    if (createdBy !== undefined && createdBy !== 'machine' && createdBy !== COORDINATOR && !board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(createdBy)) {
      throw new Refused('NO_AGENT', `the creating seat ${createdBy} is not registered; create new seats from a joined worktree or the main checkout`);
    }
    const id = lane === COORDINATOR ? COORDINATOR
      : engine < VERIFIER_STANDING_ENGINE ? `${lane}-${total + 1}` : newSeatId(board, lane, total, named);
    board.db
      .prepare(
        'INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_family, agent_created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, lane, path, route, family ?? null, now(board));
    saveJoinedSession(board, id, who);
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= 8) saveAgentModel(board, id, model);
    if (createdBy !== undefined) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`agent_creator:${id}`, createdBy);
    // Only a relay replica replaying a receipt-bound registration marks the seat enrolled.
    if (board.relayEnrollment === id && createdBy !== undefined && createdBy !== 'machine') {
      board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`agent_enrolled:${id}`, createdBy);
      // The seat's machine lineage: the creating coordinator token's, or its creator seat's.
      const lineage = createdBy === COORDINATOR ? board.verifierStanding?.lineage ?? null : seatLineage(board, createdBy);
      if (lineage) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`agent_lineage:${id}`, lineage);
    }
    logEvent(board, id, 'join', null, { lane, ...(route === 'strong' ? {} : { route }),
      ...(engine >= AGENT_GRANT_ENGINE ? { grantEngine: AGENT_GRANT_ENGINE } : {}) });
    if (board.executionEngineVersion === undefined) heartbeatSeat(board, id);
    return id;
  });
}

/**
 * The coordinator, registered at the main checkout. Only the main checkout of this repo can reach
 * this board, so when the repo moved on disk the coordinator follows it instead of refusing.
 *
 * @param {any} board
 * @param {string} path
 * @returns {string}
 */
export function ensureCoordinator(board, path) {
  const existing = board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(COORDINATOR);
  if (!existing) return register(board, { lane: COORDINATOR, path });
  if (existing.agent_path !== path) {
    atomic(board, () => {
      board.db.prepare('UPDATE agent SET agent_path = ? WHERE agent_id = ?').run(path, COORDINATOR);
      logEvent(board, COORDINATOR, 'moved', null, { path });
    });
  }
  return COORDINATOR;
}

/**
 * Refuse a route that is not one of ROUTES.
 *
 * @param {string} route
 */
function checkRoute(route) {
  if (!ROUTES.includes(route)) {
    throw new Refused('BAD_ROUTE', `route "${route}" is light (a small or local model can build it from the brief), mid (a capable model) or strong (a frontier model)`);
  }
}

/**
 * Add an item to a lane, optionally under a parent in the same lane, with a brief for whoever
 * builds it and a route saying who can (B10, B11). The caller has checked the lane and the spec
 * ids (B6).
 *
 * @param {any} board
 * @param {{ by: string, lane: string, title: string, criterion?: string, specIds?: string[], parentId?: number | null, after?: (number | string)[], brief?: string, route?: string, check?: string }} item
 * @returns {number} The new item's id.
 */
export function addItem(board, { by, lane, title, criterion = '', specIds = [], parentId = null, after = [], brief = '', route = 'strong', check, checkBaseline, barActor, referenceAuthors, referenceAuthority }) {
  return atomic(board, () => {
    const item = { by, lane, title, criterion, specIds, parentId, after, brief, route, check, checkBaseline, barActor, referenceAuthors, referenceAuthority };
    return insertItem(board, item, validateItemAddition(board, item));
  });
}

/** Insert an already validated ordinary or companion child without bypassing check or bar recording. */
function insertItem(board, item, { command, cleanTitle }) {
  const { by, lane, criterion, specIds, parentId, after, brief, route, checkBaseline, barActor } = item;
  const baseline = normalizeCheckBaseline(by, command, checkBaseline);
  const at = now(board);
  const result = board.db
    .prepare(
      `INSERT INTO item (item_parent_id, item_lane, item_title, item_criterion, item_spec_ids,
         item_after, item_brief, item_route, item_check, item_created_by, item_created_at, item_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(parentId, lane, cleanTitle, criterion.trim(), specIds.join(','), after.join(','), brief.trim(), route, command, by, at, at);
  const id = Number(result.lastInsertRowid);
  saveCheckBaseline(board, id, baseline);
  logEvent(board, by, 'add', id, { lane, specIds, after, route, ...(baseline ? { checkBaseline: baseline } : {}) });
  recordBarRevision(board, itemById(board, id), by, null, barActor);
  return id;
}

/** Read the canonical request plan before a CLI performs any authorized baseline work. */
export function planCompanion(board, options) { return companionPlan(board, options, validateItemAddition); }

/** The single ordered operation permitted to create a child in a different lane. */
export function requestCompanion(board, options) {
  return applyCompanionRequest(board, options, { validateAddition: validateItemAddition, insertItem });
}

/** Validate an addition before its sender runs a new check, and again when the ordered move applies. */
export function validateItemAddition(board, { by, lane, title, criterion = '', parentId = null, after = [], brief = '', route = 'strong', check, referenceAuthors, referenceAuthority }, { sourceMove = null } = {}) {
  const command = sourceMove
    ? validateRehomeCheck(by, check, sourceMove)
    : coordinatorCheck(by, check) ?? '';
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Refused('NO_TITLE', 'an item needs a title');
  checkRoute(route);
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (engine >= REFERENCE_ENGINE) {
    const proof = sourceMove?.referenceProof;
    validateReferences(brief, { actor: proof?.actor ?? by,
      authors: proof?.authors ?? referenceAuthors, authority: proof?.authority ?? referenceAuthority });
  }
  checkRouted({ brief: brief.trim(), route, criterion, check: command }, engine);
  if (parentId !== null) {
    const parent = itemById(board, parentId);
    if (parent.item_lane !== lane) {
      throw new Refused('PARENT_LANE', `a child item sits in its parent's lane (${parent.item_lane})`);
    }
    if (['verified', 'withdrawn'].includes(parent.item_status)) {
      throw new Refused('PARENT_CLOSED', `item #${parentId} is ${parent.item_status}`);
    }
  }
  validateItemDependencies(board, null, after);
  return { command, cleanTitle };
}

/**
 * Change an item's brief, route, criterion, check or dependencies (B10, B13, B14). At engine 8 the
 * coordinator may correct a claimed criterion, check or dependency; its holder refreezes before
 * renewal or submission and keeps the claim while adopting the correction.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, brief?: string, route?: string, criterion?: string, check?: string, after?: (number | string)[] }} change
 */
export function editItem(board, id, { agentId, brief, route, criterion, check, after, checkBaseline, reason, barActor, referenceAuthors, referenceAuthority }) {
  atomic(board, () => {
    const stored = itemById(board, id);
    const expiredHolder = stored.item_status === 'claimed' && !isHeld(board, stored) ? stored.item_owner : null;
    const { item, next, command, unfreeze, bar } = validateItemEdit(board, id, { agentId, brief, route, criterion, check, after, reason, referenceAuthors, referenceAuthority });
    const baseline = normalizeCheckBaseline(agentId, command, checkBaseline);
    const pendingFields = [
      ...(next.item_criterion !== item.item_criterion ? ['criterion'] : []),
      ...(command !== undefined && next.item_check !== item.item_check ? ['check'] : []),
      ...(next.item_after !== item.item_after ? ['after'] : []),
    ];
    const pendingRefreeze = (board.executionEngineVersion ?? ENGINE_VERSION) >= 8
      && item.item_status === 'claimed' && agentId === COORDINATOR && pendingFields.length > 0;
    const clearFrozen = (unfreeze && !pendingRefreeze) || Boolean(expiredHolder);
    if (expiredHolder) {
      moveItem(board, id, 'lapse', { checks: {}, set: () => ({ item_owner: null, item_lease_until: null }) });
    }
    setItem(board, id, { ...next, ...(clearFrozen ? { item_frozen: null, item_frozen_digest: null } : {}) });
    if (baseline || next.item_check !== item.item_check) saveCheckBaseline(board, id, baseline);
    logEvent(board, agentId, 'edit', id, {
      ...(next.item_brief !== item.item_brief ? { brief: `${next.item_brief.length} characters` } : {}),
      ...(next.item_route !== item.item_route ? { route: next.item_route } : {}),
      ...(next.item_criterion !== item.item_criterion ? { criterion: next.item_criterion } : {}),
      ...(command !== undefined ? { check: next.item_check } : {}),
      ...(next.item_after !== item.item_after ? { after: itemDependencies.dependencyValues(next) } : {}),
      ...(baseline ? { checkBaseline: baseline } : {}),
      ...(pendingRefreeze ? { pendingRefreeze: pendingFields } : {}),
      ...(clearFrozen && item.item_frozen_digest ? { unfrozen: item.item_frozen_digest } : {}),
      ...(expiredHolder ? { expiredHolder } : {}),
      ...bar,
    });
    recordBarRevision(board, itemById(board, id), agentId, item, barActor);
    notifyFileGrowth(board, item, itemById(board, id));
    if (pendingRefreeze) {
      insertShout(board, {
        from: COORDINATOR,
        to: item.item_owner,
        text: `The coordinator has a pending ${pendingFields.join(' and ')} correction for #${id}; refreeze it before renewing or submitting.\nnext: pullboard refreeze ${id}`,
        lanes: [],
      });
    }
  });
}

/** Persist both holder notices with the edit; a fixed system sender also reaches an editing holder's inbox. */
function notifyFileGrowth(board, before, after) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < FILE_GROWTH_NOTICE_ENGINE
    || !['claimed', 'submitted'].includes(before.item_status)) return;
  for (const collision of addedFileCollisions(before, after, listItems(board, { all: true }))) {
    const recipients = new Map();
    for (const item of [before, collision.item]) {
      const holder = item.item_owner || item.item_built_by;
      const to = holder && board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(holder) ? holder : COORDINATOR;
      recipients.set(to, [...(recipients.get(to) ?? []), item.item_id]);
    }
    const text = `New file overlap: #${after.item_id} grew into #${collision.item.item_id} on ${collision.shared.join(', ')}. Coordinate both items; the edit is retained.`;
    for (const [to, items] of recipients) {
      const detail = { changedItem: after.item_id, otherItem: collision.item.item_id, files: collision.shared };
      const shout = persistShout(board, { from: 'overlap', to, text, detail: { ...detail, item: items[0] } });
      // One holder may own both items: deliver once while retaining the notice on both item threads.
      for (const item of items.slice(1)) logEvent(board, 'overlap', 'shout', item, { ...detail, shout, to, text });
    }
  }
}

/** Validate an edit without side effects, so a refused change never starts a shell baseline; a bar correction needs a reason [B31]. */
export function validateItemEdit(board, id, { agentId, brief, route, criterion, check, after, reason, referenceAuthors, referenceAuthority }) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (after !== undefined && engine < 10) {
    throw new Refused('ENGINE_VERSION', `editing item dependencies requires engine 10; this board uses engine ${engine}; upgrade Pullboard before using --after`);
  }
  let item = (board.executionEngineVersion ?? ENGINE_VERSION) >= 8 ? current(board, itemById(board, id)) : null;
  if (item?.item_status === 'claimed' && agentId !== COORDINATOR) {
    throw new Refused('HELD', `item #${id} is claimed; only the coordinator may edit it while held; shout coordinator`);
  }
  const command = coordinatorCheck(agentId, check);
  if ([brief, route, criterion, check, after].every((value) => value === undefined)) {
    throw new Refused('USAGE', 'say what changes: --brief "...", --brief-file <file>, --route light|mid|strong, --criterion "...", --check "<command>" or --after <ids|none>');
  }
  item ??= current(board, itemById(board, id));
  if (agentId !== COORDINATOR && agentId !== item.item_created_by) {
    throw new Refused('NOT_YOURS', `only the coordinator or ${item.item_created_by}, who added #${id}, edits it; shout them instead`);
  }
  if (['verified', 'withdrawn'].includes(item.item_status)) {
    throw new Refused('CLOSED', `item #${id} is ${item.item_status}`);
  }
  if (after !== undefined) {
    if (!Array.isArray(after)) {
      throw new Refused('BAD_DEPENDENCIES', 'item dependencies must be an array of positive integer item ids; use --after 1,2 or --after none');
    }
    itemDependencies.validateNativeDependencies(after);
    validateItemDependencies(board, id, after);
  }
  const next = {
    item_brief: brief === undefined ? item.item_brief : brief.trim(),
    item_route: route ?? item.item_route,
    item_criterion: criterion === undefined ? item.item_criterion : criterion.trim(),
    item_check: command === undefined ? item.item_check : command,
    item_after: after === undefined ? item.item_after : after.join(','),
  };
  checkRoute(next.item_route);
  const moved = ['item_route', 'item_criterion', 'item_check', 'item_after'].filter((key) => next[key] !== item[key]);
  const routeChanged = next.item_route !== item.item_route;
  const correctionWhileClaimed = (board.executionEngineVersion ?? ENGINE_VERSION) >= 8
    && item.item_status === 'claimed' && agentId === COORDINATOR
    && (next.item_criterion !== item.item_criterion || next.item_check !== item.item_check || next.item_after !== item.item_after);
  if (moved.length && item.item_status !== 'open' && (routeChanged || !correctionWhileClaimed)) {
    throw new Refused('HELD', `item #${id} is ${item.item_status}; change its route, criterion or check only while it is open`);
  }
  if (brief !== undefined && engine >= REFERENCE_ENGINE) validateReferences(brief, { actor: agentId, authors: referenceAuthors, authority: referenceAuthority, previous: item.item_brief });
  checkRouted({ brief: next.item_brief, route: next.item_route, criterion: next.item_criterion, check: next.item_check }, engine);
  const unfreeze = next.item_criterion !== item.item_criterion || next.item_check !== item.item_check;
  return { item, next, command, unfreeze, bar: barCorrectionFields(board, item, next, { reason }) };
}

/**
 * The refusal codes src/machine.js declares for a guard of a move: the guard's own and any
 * additional typed refusals, or for the state check, the move's.
 *
 * @param {any} move
 * @param {string} id
 * @returns {string[]}
 */
function declaredCodes(move, id) {
  if (id === IN_STATE) return [move.refuse];
  const guard = GUARDS.find((entry) => entry.id === id);
  return [guard.refuse, ...(guard.alsoRefuses ?? []).map((entry) => entry.code)];
}

/**
 * Apply one declared move to an item (M1, M2). This is the only code that writes an item's status.
 *
 * It checks the move's guards, then any exit guard of its target the move does not name, in the
 * order src/machine.js declares them, and refuses with the first that does not hold. `checks` has
 * one entry per guard: a function given the item that returns null when the guard holds or the
 * refusal when it does not, or null for a guard the caller has already checked, such as the CLI's
 * look at git and the gate. The item's state is checked against the move's declared starting
 * states; its entry supplies only the refusal. Each refusal must carry the code the declaration
 * gives that guard, so the code here and the declaration cannot drift apart. Once every guard
 * holds, `before` runs, for what must exist before the write, such as the verdict that proves an
 * accept; then the target state's fields are checked and the status written with `set`.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} verb
 * @param {{ checks: Record<string, ((item: any) => Refused | null) | null>, set?: (item: any) => object, before?: (item: any) => void, transition?: object }} how
 * @returns {any} The item as it was before the move.
 */
function moveItem(board, id, verb, { checks, set = () => ({}), before = () => {}, transition = null }) {
  const move = transition ?? MOVES.find((entry) => entry.verb === verb);
  if (!move) throw new Refused(UNKNOWN_MOVE.refuse, `${UNKNOWN_MOVE.rule}: ${UNKNOWN_MOVE.next}`);
  let item = null;
  for (const guard of effectiveGuards(move)) {
    if (guard === 'itemExists') {
      item = itemById(board, id);
      continue;
    }
    if (!(guard in checks)) throw new Error(`move ${verb}: guard ${guard} has no check`);
    const check = checks[guard];
    if (check === null) continue;
    if (guard === IN_STATE && move.from.includes(item.item_status)) continue;
    const refusal = check(item);
    if (refusal === null) continue;
    const codes = declaredCodes(move, guard);
    if (!codes.includes(refusal.code)) {
      throw new Error(`move ${verb}: guard ${guard} refused with ${refusal.code}; the declaration says ${codes.join(' or ')}`);
    }
    throw refusal;
  }
  before(item);
  const fields = { ...set(item), item_status: move.to };
  const requires = STATES.find((state) => state.id === move.to).requires;
  const missing = requires.filter((field) => !String({ ...item, ...fields }[field] ?? '').trim());
  if (missing.length) throw new Error(`move ${verb}: ${move.to} needs ${missing.join(', ')}`);
  board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
  try {
    setItem(board, id, fields);
  } finally {
    board.db.exec('DELETE FROM temp.moving');
  }
  return item;
}

/**
 * The refusal when the caller is not the coordinator, or null when it is.
 *
 * @param {string} agentId
 * @param {string} what
 * @returns {Refused | null}
 */
const onlyCoordinator = (agentId, what) => (agentId === COORDINATOR ? null : new Refused('COORDINATOR_ONLY', `only the coordinator ${what}`));

/**
 * Hand an item one tier up (B15): its builder could not get it green, so it goes back open, routed
 * to the next stronger model, with what was tried pinned and why it failed in the log. A strong
 * item stays strong and goes back to the coordinator's attention.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, note: string, attempt?: string, rejections?: object[] }} why
 * @returns {{ from: string, to: string }}
 */
export function escalate(board, id, { agentId, note, attempt = '', rejections }) {
  return atomic(board, () => {
    const nextRoute = (route) => ROUTES[Math.min(ROUTES.indexOf(route) + 1, ROUTES.length - 1)];
    const item = moveItem(board, id, 'escalate', {
      checks: {
        joined: null,
        noteGiven: () => (note.trim() ? null : new Refused('NOTE_REQUIRED', 'say what was tried and how it failed: --note "..."')),
        holderOrCoordinator: (found) => {
          const live = current(board, found);
          const isHolder = live.item_status === 'claimed' && live.item_owner === agentId;
          return isHolder || agentId === COORDINATOR ? null : new Refused('NOT_YOURS', `item #${id} is not claimed by you; only its holder or the coordinator escalates it`);
        },
        [IN_STATE]: (found) => new Refused('CLOSED', `item #${id} is ${current(board, found).item_status}; escalate open or claimed work only`),
      },
      set: (found) => ({ item_route: nextRoute(found.item_route), item_owner: null, item_lease_until: null }),
    });
    const from = item.item_route;
    const to = nextRoute(from);
    logEvent(board, agentId, 'escalate', id, {
      from, to, note: note.trim(), ...(attempt ? { attempt } : {}), ...(rejections ? { rejections } : {}),
    });
    return { from, to };
  });
}

/**
 * Record one unattended attempt at an item (A11): which try, how long, and how it ended, so each
 * route's record shows whether its tier pays.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, n: number, seconds: number, result: string }} attempt
 */
export function recordAttempt(board, id, { agentId, n, seconds, result }) {
  logEvent(board, agentId, 'attempt', id, { n, seconds, result });
}

/**
 * Claim an item, or renew your own claim (B4, B5, B12, V2).
 *
 * One live top-level claim per agent, so nobody hoards; child items are free, which is how
 * sub-agents share a lane. A lapsed claim can be taken. Every item is built in its own lane, the
 * coordinator's included, so no agent can build another lane's work from the main checkout. The
 * first claim freezes the criterion: `freeze` returns the text and digest the verdict will later be
 * held to. A fresh claim also records `head`, the commit the work starts from, so submit can name
 * the files the item changed (N21). A held lane takes no new claims (N22); renewals go on.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, lane: string, leaseMs: number, freeze: (item: any) => { text: string, digest: string }, head?: string | null, reviewSkipped?: object | null }} who
 * @returns {{ leaseUntil: string, digest: string, renewed: boolean }}
 */
export function claim(board, id, { agentId, lane, leaseMs, freeze, head = null, reviewSkipped = null, reviewPolicy = 'any', familyPolicy = 'off', submitAdmission = null }) {
  return atomic(board, () => {
    const admission = checkedSubmitAdmission(board, id, agentId, submitAdmission);
    const leaseUntil = new Date(board.clock.now().getTime() + leaseMs).toISOString();
    const isRenewal = (item) => item.item_owner === agentId && isHeld(board, item);
    // Reworking your own rejected item is a claim of its own, beside the one live claim (B5): the
    // builder fixing what a verifier found need not drop its other work to do it.
    const isRework = (item) => item.item_verdict === 'REJECT' && item.item_built_by === agentId;
    let frozen = null;
    const item = moveItem(board, id, 'claim', {
      checks: {
        joined: null, checkProvesSomething: null,
        barReady: found => barReadyProblem(board, found),
        [IN_STATE]: (found) => new Refused('NOT_CLAIMABLE', `item #${id} is ${found.item_status}`),
        inLane: (found) => {
          const outside = outsideBuildProblem(board, found);
          if (outside) return outside;
          if (found.item_lane === lane) return null;
          return new Refused(
            'WRONG_LANE',
            lane === COORDINATOR
              ? `item #${id} is in the ${found.item_lane} lane, and lane items are built from that lane's worktree, never the main checkout. An agent runs: cd <its own worktree> && pullboard claim ${id}`
              : `item #${id} is in the ${found.item_lane} lane; you are in ${lane}`,
          );
        },
        routeAllows: (found) => {
          const route = routeOf(board, agentId);
          return canTake(route, found.item_route) ? null : new Refused('ROUTE', `item #${id} needs a ${found.item_route} model; you joined on the ${route} route. Take your next item: pullboard next`);
        },
        dependenciesVerified: (found) => {
          const foreign = foreignBlockers(board, found)[0];
          if (foreign) return new Refused('BLOCKED', `#${id} waits on ${itemDependencies.dependencyLabel(foreign)} (${foreign.status} on its own board); refresh that board before claiming`);
          for (const dependency of itemDependencies.localDependencyIds(found)) {
            const before = itemById(board, dependency);
            if (before.item_status !== 'verified') {
              return new Refused(
                'BLOCKED',
                `#${id} waits on #${dependency} (${current(board, before).item_status}, ${before.item_lane} lane); claim another item, or shout ${before.item_lane} if it is stuck`,
              );
            }
          }
          return null;
        },
        notHeldByAnother: (found) => (isHeld(board, found) && found.item_owner !== agentId ? new Refused('HELD', `item #${id} is held by ${found.item_owner} until ${found.item_lease_until}`) : null),
        builderFirstRefusal: () => (board.executionEngineVersion ?? ENGINE_VERSION) >= REOPEN_FIRST_REFUSAL_ENGINE ? firstRefusalProblem(board, id, agentId) : null,
        correctionRefrozen: () => pendingRefreezeProblem(board, id),
        laneOpen: (found) => {
          // Declared: not checked when the caller renews its own live claim.
          const paused = laneHold(board, found.item_lane);
          return paused && !isRenewal(found)
            ? new Refused('LANE_HELD', `${paused.hold_by} holds the ${found.item_lane} lane: ${paused.hold_reason}. Wait for it: pullboard next --wait 9 (minutes)`)
            : null;
        },
        itemNotHeld: (found) => {
          const held = itemHold(board, found.item_id);
          return held && !isRenewal(found)
            ? new Refused('ITEM_HELD', `item #${id} is held by coordinator: ${held.item_hold_reason}; wait for the coordinator to lift it with pullboard hold ${id} --off`)
            : null;
        },
        lineCapacity: found => capacity.claimProblem(board, isRenewal(found), { agentId, policy: reviewPolicy, familyPolicy }, { reviewerChecks, reviewReleaseCooldown }),
        oneLiveClaim: (found) => {
          if (found.item_parent_id !== null || isRework(found)) return null;
          const other = board.db
            .prepare(
              `SELECT item_id FROM item WHERE item_owner = ? AND item_status = 'claimed'
                 AND item_lease_until > ? AND item_id != ? AND item_parent_id IS NULL
                 AND NOT (COALESCE(item_verdict, '') = 'REJECT' AND COALESCE(item_built_by, '') = ?)`,
            )
            .get(agentId, now(board), id, agentId);
          return other ? new Refused('ONE_CLAIM', `you already hold #${other.item_id}; submit or release it first (child items are free)`) : null;
        },
        rowsInForce: (found) => {
          // Declared: checked only where the criterion freezes, so a renewal or a reclaim keeps its bar.
          if (found.item_frozen_digest !== null) return null;
          try {
            frozen = freeze(found);
            return null;
          } catch (error) {
            if (error instanceof Refused) return error;
            throw error;
          }
        },
      },
      set: (found) => ({
        ...(frozen ? { item_frozen: frozen.text, item_frozen_digest: frozen.digest } : {}),
        ...(!isRenewal(found) && head ? { item_claim_head: head } : {}),
        item_owner: agentId,
        item_lease_until: leaseUntil,
      }),
    });
    const renewed = isRenewal(item);
    const digest = frozen ? frozen.digest : item.item_frozen_digest;
    // A linked coordinator claim records which machine's coordinator lineage builds it (#579).
    if (board.verifierStanding && agentId === COORDINATOR && (board.executionEngineVersion ?? ENGINE_VERSION) >= VERIFIER_STANDING_ENGINE) {
      board.db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run(`item_lineage:${id}`);
      if (board.verifierStanding.lineage) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`item_lineage:${id}`, board.verifierStanding.lineage);
    }
    logEvent(board, agentId, renewed ? 'renew' : 'claim', id, { leaseUntil, digest, ...(!renewed && reviewSkipped ? { reviewSkipped } : {}),
      ...(admission ? { submitAdmission: admission } : {}),
      ...((board.executionEngineVersion ?? ENGINE_VERSION) >= AGENT_GRANT_ENGINE ? { grantEngine: AGENT_GRANT_ENGINE } : {}) });
    return { leaseUntil, digest, renewed };
  });
}

/**
 * Hand a claimed item back, or free the caller's live review reservation on a submitted item.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} agentId
 * @param {string} [note] One-line reason required when releasing a submitted review.
 * @returns {boolean} Whether a review reservation was released rather than a claim.
 */
export function release(board, id, agentId, note = '') {
  return atomic(board, () => {
    const item = itemById(board, id);
    if (item.item_status === 'submitted') {
      if (reviewHolder(board, item) !== agentId) {
        throw new Refused('NOT_YOURS', `item #${id} review is not reserved by you; ask its current reviewer to release it, or take a free review with pullboard next --verify`);
      }
      const currentEngine = board.executionEngineVersion ?? ENGINE_VERSION;
      const problem = currentEngine >= 5 ? reviewReleaseNoteProblem(board, id, agentId, note) : null;
      if (problem) throw problem;
      const reason = typeof note === 'string' ? note.trim() : '';
      setItem(board, id, { item_review_by: null, item_review_until: null });
      if (currentEngine >= 5) logEvent(board, agentId, 'release', id, { review: true, reason });
      else logEvent(board, agentId, 'release', id);
      return true;
    }
    const window = (board.executionEngineVersion ?? ENGINE_VERSION) >= REOPEN_FIRST_REFUSAL_ENGINE ? firstRefusal(board, id) : null;
    moveItem(board, id, 'release', {
      transition: (board.executionEngineVersion ?? ENGINE_VERSION) < REOPEN_FIRST_REFUSAL_ENGINE ? { ...MOVES.find(move => move.verb === 'release'), from: ['claimed'] } : null,
      checks: {
        joined: null,
        [IN_STATE]: () => new Refused('NOT_YOURS', `item #${id} is not claimed by you`),
        releaseOwnsWork: (found) => (found.item_owner === agentId || found.item_status === 'open' && window?.builder === agentId ? null : new Refused('NOT_YOURS', `item #${id} is not claimed by you`)),
        reviewReleaseExplained: null, // Claimed releases do not free a submitted review.
      },
      set: () => ({ item_owner: null, item_lease_until: null }),
    });
    logEvent(board, agentId, 'release', id);
    return false;
  });
}

export { prepareMergeOnlySubmit };

/**
 * Submit your claimed item at a commit (V4, V6). The caller has already checked the tree is clean
 * and run the gate green at that commit.
 *
 * Work a verifier rejected comes back only at a new head, so "done again" can never be the same
 * code declared twice.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, commit: string, tree: string, files?: string[], policyCommit?: string, note?: string }} at - `files`: what the
 *   item's own commits changed since its claim; a rework adds to what the first attempt changed.
 */
export function submit(board, id, { agentId, commit, tree, files = [], policyCommit = null, note, submissionProof: proof, submissionSize: size, infra = null, gateGreen, mergeOnly: recordedCarry }) {
  let recordedProof;
  let recordedSize;
  if (note !== undefined && (typeof note !== 'string' || !note.trim() || /[\r\n\u2028\u2029]/u.test(note))) {
    throw new Refused('USAGE', 'a submission note, when present, is one nonempty line');
  }
  atomic(board, () => {
    const modern = (board.executionEngineVersion ?? ENGINE_VERSION) >= MERGE_ONLY_VERDICT_ENGINE;
    const basis = modern && gateGreen === true ? mergeOnlyBasis(board, getItem(board, id)) : null;
    const mergeOnly = modern ? board.executionEngineVersion === undefined
      ? prepareMergeOnlySubmit(board, id, { commit, tree, policyCommit, gateGreen })
      : recordedCarry ?? null : null;
    const carry = Boolean(mergeOnly);
    const carriedProblem = found => mergeOnlyProblem(board, found, mergeOnly, { commit, tree, policyCommit });
    const notYours = () => new Refused('NOT_YOURS', `item #${id} is not claimed by you; claim it first`);
    moveItem(board, id, 'submit', {
      ...(carry ? { transition: MOVES.find(move => move.verb === 'submit-merge') } : {}),
      checks: {
        joined: null, checkProvesSomething: null,
        barReady: found => barReadyProblem(board, found),
        [IN_STATE]: notYours,
        isHolder: (found) => outsideBuildProblem(board, found) ?? (found.item_owner === agentId ? null : notYours()),
        correctionRefrozen: () => pendingRefreezeProblem(board, id),
        criterionUnchanged: null,
        treeClean: null,
        nothingUntracked: null,
        hasCommit: null,
        withinLane: null,
        trunkMergeClean: null,
        trunkInCandidate: null,
        noUnverifiedStack: null,
        infraExplained: null, // The CLI checks the claimed Git diff before this transition.
        doctrineHolds: null,
        gateConfigured: null, queuedItemLease: null,
        gateGreen: null,
        proofRecorded: null, // The CLI records and validates native receipts before sealing submit; replay needs no origin files.
        treeStillDuringGate: null,
        ...(carry ? {
          mergeOnlyRecorded: carriedProblem,
          atSubmittedCommit: null, // The same post-gate HEAD check binds both submission paths.
          notBuilder: found => retainedVerifierIdentityProblem(board, found, basis.by),
          proofNoted: () => typeof mergeOnly?.resolutionDiff === 'string' ? null : new Refused('PROOF_REQUIRED', 'record the actual merge resolution diff'),
        } : {}),
        submissionProofValid: () => {
          if ((board.executionEngineVersion ?? ENGINE_VERSION) >= SUBMISSION_PROOF_ENGINE) recordedProof = submissionProof(proof, board.executionEngineVersion ?? ENGINE_VERSION);
          if ((board.executionEngineVersion ?? ENGINE_VERSION) >= FLOW_SIZE_ENGINE) recordedSize = submissionSize(size, commit);
          return null;
        },
        childrenDone: () => {
          const { total } = board.db
            .prepare("SELECT COUNT(*) AS total FROM item WHERE item_parent_id = ? AND item_status IN ('open', 'claimed', 'submitted')")
            .get(id);
          return total ? new Refused('CHILDREN_OPEN', `item #${id} has ${total} unfinished child items`) : null;
        },
        headIsNew: (found) => {
          const engineVersion = board.executionEngineVersion ?? ENGINE_VERSION;
          const rejectedHead = board.db.prepare(
            "SELECT 1 FROM verdict WHERE item_id = ? AND verdict_decision = 'REJECT' AND verdict_commit = ? AND (? < 9 OR verdict_digest = ?) LIMIT 1",
          ).get(id, commit, engineVersion, found.item_frozen_digest);
          const sameReopenedHead = found.item_verdict === null && found.item_commit === commit
            && !(engineVersion >= 11 && correctedNoVerdictReopen(board, id, commit));
          return rejectedHead || sameReopenedHead
            ? new Refused('HEAD_NOT_NEW', `#${id} already has a submission at ${commit.slice(0, 12)}; commit the rework first`)
            : null;
        },
      },
      before: () => { if (carry) logEvent(board, agentId, 'merge-only-accept', id, { ...mergeOnly, by: basis.by }); },
      set: found => submissionItemValues(board, found, { agentId, commit, tree, files, carry, basis }),
    });
    recordSubmissionEvent(board, id, { agentId, commit, tree, policyCommit, note, recordedProof, infra,
      modern, gateGreen, carry, mergeOnly, recordedSize, engineVersion: board.executionEngineVersion ?? ENGINE_VERSION });
  });
}

export { reviewHolder } from './board-query.js';

/** Validate a newly constructed review release while keeping old sealed replay executable [V1,R1,H16].
 * @param {any} board
 * @param {number} itemId
 * @param {string} agentId
 * @param {unknown} note
 * @returns {Refused | null}
 */
export function reviewReleaseNoteProblem(board, itemId, agentId, note) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < 5) return null;
  let item;
  try { item = getItem(board, itemId); }
  catch (error) {
    // Missing items keep their native, ordered refusal; this preflight only validates review notes.
    if (error instanceof Refused && error.code === 'NO_ITEM') return null;
    throw error;
  }
  if (item.item_status !== 'submitted' || reviewHolder(board, item) !== agentId) return null;
  const reason = typeof note === 'string' ? note.trim() : '';
  if (!reason || /[\r\n\u2028\u2029]/u.test(reason)) {
    return new Refused('NOTE_REQUIRED', 'give the review release a one-line reason with --note "..."');
  }
  return null;
}

/** Return a reviewer's active one-hour cooldown, if a later submission has not reset it [V1,R1]. */
function reviewReleaseCooldown(board, itemId, agentId) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < 5) return null;
  const event = reviewReleasesSinceSubmit(board, itemId, agentId).find((release) => !release.legacy);
  if (!event) return null;
  const until = Date.parse(event.event_at) + REVIEW_RELEASE_COOLDOWN_MS;
  return until > board.clock.now().getTime() ? new Date(until).toISOString() : null;
}

export { reviewQueueBreakdown } from './board-query.js';

export { reviewQueue } from './board-query.js';

/** Offer an eligible review at the queue ratio without claiming or reserving anything [Q1,V15]. */
export function reviewOffer(board, who) {
  return capacity.reviewOffer(board, who, nextFor);
}

/**
 * What a verifier must pass before it reviews an item, alike when it reserves the review and when
 * it gives its verdict: it did not build the item, its route covers the item's, the repo's verify
 * policy lets it, and no other agent holds the review (V15). A reservation that lapsed holds
 * nothing, so the agent that made it can still give its verdict unless another reserved it since.
 *
 * @param {any} board
 * @param {{ agentId: string, policy: string, familyPolicy?: string }} who
 * @returns {Record<string, (found: any) => Refused | null>}
 */
function reviewerChecks(board, { agentId, policy, familyPolicy = 'off' }) {
  const family = board.db.prepare('SELECT agent_family FROM agent WHERE agent_id = ?').get(agentId)?.agent_family ?? null;
  return {
    notBuilder: (found) => itemAuthorProblem(board, found, agentId),
    routeAllows: (found) => {
      const route = routeOf(board, agentId);
      return canTake(route, found.item_route) ? null : new Refused('ROUTE', `item #${found.item_id} needs a ${found.item_route} verifier; you joined on the ${route} route`);
    },
    policyAllows: (found) =>
      policy === COORDINATOR && found.item_lane !== COORDINATOR && agentId !== COORDINATOR ? new Refused('COORDINATOR_VERIFIES', 'this repo has the coordinator verify lane work') : null,
    familyAllows: (found) => familyPolicy === 'require' && (!family || !found.item_builder_family || family === found.item_builder_family)
      ? new Refused('O2_FAMILY_MATCH', `#${found.item_id} needs a verifier from another declared family under verify.family require; ask the coordinator to assign one`)
      : null,
    reviewFree: (found) => {
      const holder = reviewHolder(board, found);
      return holder && holder !== agentId
        ? new Refused('REVIEW_HELD', `${holder} holds the review of #${found.item_id} until ${found.item_review_until}; take another: pullboard next --verify`)
        : null;
    },
  };
}

/**
 * Reserve an item's review for an agent under a lease (V15): until it runs out, another agent's
 * verdict on the item, or reservation of it, is refused. Reserving again renews the lease.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, leaseMs: number, policy: string, familyPolicy?: string }} who
 * @returns {any} The item, reserved.
 */
export function reserveReview(board, id, who) {
  return atomic(board, () => reserveWithin(board, id, who));
}

/**
 * `next --verify` (V15): find the next review the agent may take and reserve it in one
 * transaction, so no other verifier can take it between the look and the reservation.
 *
 * @param {any} board
 * @param {{ agentId: string, lane: string, leaseMs: number, policy: string, familyPolicy?: string, runnable?: boolean, routes?: string[], skipIds?: number[] }} who - skipIds: items the caller's own session built, never offered (verify refuses them too)
 * @returns {{ item: any | null, reasons: string[] }}
 */
export function reserveNextReview(board, { agentId, lane, leaseMs, policy, familyPolicy = 'off', runnable, routes, skipIds = [] }) {
  return atomic(board, () => {
    const { item, reasons } = nextFor(board, { agentId, lane, verify: true, familyPolicy, runnable, routes, skipIds });
    return item ? { item: reserveWithin(board, item.item_id, { agentId, leaseMs, policy, familyPolicy }), reasons } : { item: null, reasons };
  });
}

/**
 * The reserve move, inside a transaction the caller holds.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, leaseMs: number, policy: string, familyPolicy?: string }} who
 * @returns {any}
 */
function reserveWithin(board, id, { agentId, leaseMs, policy, familyPolicy = 'off' }) {
  const until = new Date(board.clock.now().getTime() + leaseMs).toISOString();
  moveItem(board, id, 'reserve', {
    checks: {
      coordinatorSaysAs: null,
      joined: null,
      roadmapReadable: null, // Selection reads recorded queue policy and roadmap before this move; explicit ids consult neither.
      [IN_STATE]: (found) => new Refused('NOT_SUBMITTED', `item #${id} is ${current(board, found).item_status}, not submitted`),
      /** Enforce the cooldown after state validation and before reviewer eligibility [V1]. */
      reviewCooldownElapsed: () => {
        const cooldown = reviewReleaseCooldown(board, id, agentId);
        return cooldown ? new Refused('REVIEW_COOLDOWN', `you released the review of #${id}; try again after ${cooldown}, or let another reviewer take it`) : null;
      },
      ...reviewerChecks(board, { agentId, policy, familyPolicy }),
    },
    set: () => ({ item_review_by: agentId, item_review_until: until }),
  });
  logEvent(board, agentId, 'reserve', id, { until });
  return getItem(board, id);
}

/**
 * Record a verdict on submitted work, or a sealed re-review of unlanded work (E8,V1,V3,V8).
 * An accept verifies it; a reject
 * reopens it for rework.
 *
 * The verdict binds the submitted commit and the digest frozen at claim. If the criterion's text
 * has moved since, there is no verdict to give: the coordinator refreezes it and the work is
 * claimed again. The builder never verifies; under `verify: "coordinator"`, lane work is the
 * coordinator's to verify; an agent verifies items at its tier or below, and not while another
 * agent holds the review (V15). An accept means CRITERION_MET and says how it was proved; a reject
 * names one of the reject reasons and says what failed, and may name its cause key for rigor (#713).
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, decision: string, reason?: string, note?: string, cause?: string, head: string, digest: string, policy: string, familyPolicy?: string, check?: 'none' | 'green', review?: {commit: string, head?: string, trunk: string, paths: string[]}, implies?: number[], impliesId?: string }} verdict - implies: items this verdict changes (B29)
 * @returns {{ decision: string, reason: string, check?: 'none' | 'green' }}
 */
export function verify(board, id, { agentId, decision, reason, note = '', cause, head, digest, policy, familyPolicy = 'off', check, review, implies, impliesId, reopenFirstRefusalMinutes, environment, sandbox }) {
  const verb = { ACCEPT: 'accept', REJECT: 'reject' }[decision];
  if (!verb) throw new Refused('BAD_DECISION', 'the decision is accept or reject');
  const isAccept = verb === 'accept';
  const code = isAccept ? ACCEPT_REASON : reason;
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  landingEnvironment.requireVerdict(board, environment);
  const declaration = MOVES.find(move => move.verb === verb);
  const newReview = engine >= VERDICT_REVIEW_ENGINE && review !== undefined;
  // Without the new sealed metadata, old moves keep their exact submitted-only semantics.
  const transition = newReview ? declaration : { ...declaration, from: ['submitted'],
    guards: declaration.guards.filter(guard => !['notMerged', 'verdictReviewRecorded', 'reviewTreeCurrent'].includes(guard)) };
  return atomic(board, () => {
    const item = moveItem(board, id, verb, {
      transition,
      checks: {
        coordinatorSaysAs: null,
        joined: null,
        [IN_STATE]: (found) => new Refused('NOT_SUBMITTED', `item #${id} is ${current(board, found).item_status}, not submitted`),
        atSubmittedCommit: null,
        notMerged: found => !found.item_merged_commit ? null
          : new Refused('ALREADY_MERGED', `item #${id} already landed; only unlanded acceptances can be re-reviewed`),
        verdictReviewRecorded: found => verdictReviewProblem(review, found.item_commit, { checked: engine >= VERDICT_REVIEW_ENGINE }),
        reviewTreeCurrent: null,
        ...reviewerChecks(board, { agentId, policy, familyPolicy }),
        criterionUnchanged: (found) =>
          digest === found.item_frozen_digest
            ? null
            : new Refused('CRITERIA_CHANGED', `the criterion for #${id} changed after it was claimed; the coordinator runs: pullboard refreeze ${id}`),
        reasonIsMet: () => (reason && reason !== ACCEPT_REASON ? new Refused('BAD_REASON', `accept means ${ACCEPT_REASON}; a failed criterion is a reject`) : null),
        trunkMergeClean: null,
        noUnverifiedStack: null, queuedItemLease: null,
        itemCheckGreen: found => isAccept ? outsideSandboxProblem(board, found, sandbox) : null,
        proofRecorded: null, // The native verifier records the gate receipt before this ordered outcome.
        proofNoted: () =>
          note.trim()
            ? null
            : new Refused('PROOF_REQUIRED', 'an accept says how you proved it: --note "what you broke or which edge you tried, and what happened"; passing tests alone are not proof'),
        reasonCoded: () => (reason && REJECT_REASONS.includes(reason) ? null : new Refused('BAD_REASON', `a reject names one of: ${REJECT_REASONS.join(', ')}`)),
        noteGiven: () => (note.trim() ? null : new Refused('NOTE_REQUIRED', 'a reject says what failed: --note "..."')),
        causeWellFormed: () => causeProblem(cause),
      },
      before: (found) => recordVerdict(board, found, { agentId, decision, reason: code, note, digest, head }),
      set: (found) => ({ item_verdict: decision, item_verified_by: isAccept ? agentId : null, item_owner: isAccept ? found.item_owner : null }),
    });
    if (isAccept && sandbox && outsideSource(board, id)) saveOutsideSource(board, id, { ...outsideSource(board, id), sandbox });
    const returnedAt = !isAccept && engine >= REOPEN_FIRST_REFUSAL_ENGINE && reopenFirstRefusalMinutes > 0 && item.item_built_by ? board.clock.now() : undefined;
    const reservation = !isAccept && engine >= REOPEN_FIRST_REFUSAL_ENGINE ? firstRefusalDetail(board, item, reopenFirstRefusalMinutes, returnedAt) : {};
    const derivedCause = !isAccept && engine >= RIGOR_AUTO_ENGINE
      ? deriveRigorCause(board, item, { cause, reason: code, agentId }) : !isAccept && cause != null ? { cause } : {};
    const detail = { ...reservation, reason: code, commit: item.item_commit, ...derivedCause };
    if (isAccept && engine >= SPEC_APPROVAL_ENGINE) detail.note = note.trim();
    if (isAccept && check !== undefined) detail.check = check;
    if (environment !== undefined) detail.environment = environment;
    if (sandbox !== undefined) detail.sandbox = sandbox;
    if (newReview) detail.review = { commit: review.commit, ...(Object.hasOwn(review, 'head') ? { head: review.head } : {}), trunk: review.trunk, paths: [...review.paths] };
    logEvent(board, agentId, verb, id, implies?.length ? { ...detail, implies } : detail, returnedAt);
    const trigger = board.lastEvent;
    tellFirstRefusal(board, item, reservation, persistShout);
    if (!isAccept) recordRejectedItemRoute(board, id, engine, item, { escalate, shout, logEvent });
    tellVerdictImplications(board, (by, itemId, fact) => logEvent(board, by, 'fact', itemId, fact), id, { seed: impliesId, implies });
    if (!isAccept) postRigorNotices(board, trigger);
    return { decision, reason: code, ...(isAccept && check !== undefined ? { check } : {}) };
  });
}

/** Return a submission for correction, or a verified item after a recorded red landing, without
 * rewriting its prior verdict [V2,V6]. The prior commit remains the builder's rework base.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, note: string, cause?: string, withdrawVerdict?: boolean }} request
 * @returns {{ id: number, commit: string, supersedes?: number, landingFailure?: object }}
 */
export function reopen(board, id, { agentId, note = '', conflict, cause, reopenFirstRefusalMinutes, quotedLandingFailure, withdrawVerdict, computedConflict }) {
  return atomic(board, () => {
    let submittedCommit = null;
    const assertedConflict = conflict;
    conflict = computedConflictEvidence.conflictValue(computedConflict, conflict);
    const forMerge = conflict !== undefined && conflict !== null;
    let supersedes, landingFailure, withdrawnVerdict;
    const forWithdrawal = withdrawVerdict === true;
    const currentEngine = board.executionEngineVersion ?? ENGINE_VERSION;
    verdictWithdrawal.checkOptions(withdrawVerdict, forMerge, currentEngine);
    const declaredTransition = MOVES.find((entry) => entry.verb === 'reopen');
    const transition = currentEngine >= 10 ? declaredTransition : { ...declaredTransition, from: ['submitted'] };
    const item = moveItem(board, id, 'reopen', {
      transition,
      checks: {
        joined: null,
        [IN_STATE]: (found) => new Refused('NOT_SUBMITTED', `item #${id} is ${current(board, found).item_status}, not submitted`),
        reopenAuthority: (found) => reopenAuthority(board, found, agentId,
          { forWithdrawal, forMerge, currentEngine, computedConflict, assertedConflict }, value => { withdrawnVerdict = value; }),
        noteGiven: () => (forMerge || note.trim() ? null : new Refused('NOTE_REQUIRED', 'say why the criterion needs correction: --note "why"')),
        causeWellFormed: () => causeProblem(cause),
        notMerged: (found) => found.item_status !== 'verified' || !found.item_merged_commit
          ? null
          : new Refused('ALREADY_MERGED', `item #${id} was merged as ${found.item_merged_commit}; merged items cannot be reopened`),
        landingFailureRecorded: (found) => {
          if (forWithdrawal) { supersedes = withdrawnVerdict.acceptEventId; return null; }
          if (found.item_status !== 'verified' || forMerge) return null;
          const accepted = events(board, { itemId: id }).findLast((event) => {
            if (!['accept', 'merge-only-accept'].includes(event.event_kind)) return false;
            return JSON.parse(event.event_detail).commit === found.item_commit;
          });
          const recorded = landingBatches(board).flatMap((batch) => (batch.culprits ?? []).map((culprit) => ({ batch, culprit })))
            .find(({ culprit }) => culprit.id === id && culprit.commit === found.item_commit && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(culprit.mergeCommit ?? '')
              && Array.isArray(culprit.tests) && culprit.tests.length
              && culprit.tests.every((failure) => typeof failure.file === 'string' && typeof failure.name === 'string'
                && note.includes(`${failure.file}: ${failure.name}`) && note.includes(culprit.mergeCommit)));
          const quoted = currentEngine >= QUOTED_LANDING_FAILURE_ENGINE;
          const manual = manualLandingFailure(note, { quoted: quoted && (quotedLandingFailure === true || manualLandingFailureQuoted(note)) });
          if (!accepted || (!recorded && !manual)) return new Refused('LANDING_FAILURE_REQUIRED',
            `reopening verified item #${id} needs --note in the format <test file>: <test name>; merge commit <sha>${quoted ? ', or quote a test name containing a semicolon' : ''}`,
            quoted ? NEXT_STEPS.LANDING_FAILURE_REQUIRED : undefined);
          supersedes = accepted.event_id;
          landingFailure = recorded
            ? { batch: recorded.batch.id, tests: recorded.culprit.tests, mergeCommit: recorded.culprit.mergeCommit }
            : { batch: null, tests: manual.tests, mergeCommit: manual.mergeCommit };
          return null;
        },
        trunkConflicts: null,
        conflictAccepted: (found) => (forMerge ? conflictProblem(board, found, conflict, (accept) => { supersedes = accept; }) : null),
      },
      set: (found) => {
        submittedCommit = found.item_commit;
        return {
          item_verdict: null,
          item_verified_by: null,
          item_owner: null,
          item_lease_until: null,
          item_review_by: null,
          item_review_until: null,
        };
      },
    });
    const returnedAt = (forMerge || landingFailure || forWithdrawal) && currentEngine >= REOPEN_FIRST_REFUSAL_ENGINE && reopenFirstRefusalMinutes > 0 && item.item_built_by ? board.clock.now() : undefined;
    const reservation = (forMerge || landingFailure || forWithdrawal) && currentEngine >= REOPEN_FIRST_REFUSAL_ENGINE ? firstRefusalDetail(board, item, reopenFirstRefusalMinutes, returnedAt) : {};
    const returned = forWithdrawal ? { supersedes, withdrawnVerdict } : forMerge ? { supersedes, ...conflictDetail(conflict), ...(computedConflict !== undefined ? { computedConflict } : {}) } : supersedes ? { supersedes, landingFailure } : {};
    const derivedCause = currentEngine >= RIGOR_AUTO_ENGINE
      ? deriveRigorCause(board, item, { cause, conflict, landingFailure, agentId }) : cause != null ? { cause } : {};
    const returnedWithCause = currentEngine >= RIGOR_AUTO_ENGINE ? { ...returned, ...derivedCause } : { ...derivedCause, ...returned };
    logEvent(board, agentId, 'reopen', id, { commit: submittedCommit, note: note.trim() || conflictNote(conflict), judgment: null, ...reservation,
      ...returnedWithCause }, returnedAt);
    const trigger = board.lastEvent;
    tellFirstRefusal(board, item, reservation, persistShout);
    if (!reservation.reopenFirstRefusal && forMerge && supersedes === undefined && item.item_built_by) persistShout(board, { from: agentId, to: item.item_built_by, text: returnedHeadNotice(id, submittedCommit, conflict) });
    postRigorNotices(board, trigger);
    return { id: item.item_id, commit: submittedCommit, ...returnedWithCause };
  });
}

/**
 * Refuse unless the acting agent is the coordinator.
 *
 * @param {string} agentId
 * @param {string} what
 */
function coordinatorOnly(agentId, what) {
  const refusal = onlyCoordinator(agentId, what);
  if (refusal) throw refusal;
}

/**
 * Record the commit a verified item landed as on the main line, e.g. after a squash merge.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, commit: string, note?: string }} merge
 */
export function merged(board, id, { agentId, commit, note = '' }) {
  coordinatorOnly(agentId, 'records merges');
  atomic(board, () => {
    const item = itemById(board, id);
    if (item.item_status !== 'verified') {
      throw new Refused('NOT_VERIFIED', `item #${id} is ${item.item_status}; merge verified work only`);
    }
    requireOutsideOwner(board, item);
    setItem(board, id, { item_merged_commit: commit });
    logEvent(board, agentId, 'merged', id, { commit, ...(note.trim() ? { note: note.trim() } : {}) });
  });
}

/**
 * Withdraw an item nobody should build: a duplicate, or no longer wanted.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, reason: string }} why
 */
export function withdraw(board, id, { agentId, reason }) {
  atomic(board, () => {
    moveItem(board, id, 'withdraw', {
      checks: {
        joined: null,
        coordinatorOnly: () => onlyCoordinator(agentId, 'withdraws items'),
        noteGiven: () => (reason.trim() ? null : new Refused('NOTE_REQUIRED', 'say why it is withdrawn')),
        [IN_STATE]: (found) => new Refused('CLOSED', `item #${id} is ${found.item_status}`),
      },
      set: () => ({ item_withdrawn_reason: reason.trim(), item_owner: null, item_lease_until: null }),
    });
    logEvent(board, agentId, 'withdraw', id, { reason: reason.trim() });
  });
}

/**
 * Freeze the current criterion and rows again (V2,V3). A pending coordinator correction is
 * adopted within its live claim, keeping the holder, lease and base; other refreezes reopen the
 * item so its next claim builds against the bar a verdict will check.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, freeze: (item: any) => { text: string, digest: string } }} who
 * @returns {{ before: string | null, after: string, retainedClaim?: true }}
 */
export function refreeze(board, id, { agentId, freeze }) {
  return atomic(board, () => {
    let frozen = null;
    const currentItem = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
    const pending = currentItem ? pendingRefreeze(board, id) : [];
    const retainsClaim = (board.executionEngineVersion ?? ENGINE_VERSION) >= 8
      && currentItem?.item_status === 'claimed' && isHeld(board, currentItem) && pending.length > 0;
    const transition = MOVES.find((move) => move.verb === 'refreeze' && move.to === (retainsClaim ? 'claimed' : 'open'));
    const item = moveItem(board, id, 'refreeze', {
      checks: {
        joined: null,
        barReady: found => barReadyProblem(board, found),
        coordinatorOnly: () => onlyCoordinator(agentId, 'refreezes a criterion'),
        holderOrCoordinator: (found) => {
          const live = current(board, found);
          return live.item_owner === agentId || agentId === COORDINATOR
            ? null
            : new Refused('NOT_YOURS', `item #${id} is not claimed by you; only its holder or the coordinator refreezes it`);
        },
        [IN_STATE]: (found) => new Refused('CLOSED', `item #${id} is ${found.item_status}`),
        rowsInForce: (found) => {
          try {
            frozen = freeze(found);
            return null;
          } catch (error) {
            if (error instanceof Refused) return error;
            throw error;
          }
        },
      },
      set: () => ({
        item_frozen: frozen.text,
        item_frozen_digest: frozen.digest,
        ...(!retainsClaim ? { item_owner: null, item_lease_until: null } : {}),
      }),
      transition,
    });
    logEvent(board, agentId, 'refreeze', id, { before: item.item_frozen_digest, after: frozen.digest, ...(retainsClaim ? { retainedClaim: true } : {}) });
    return { before: item.item_frozen_digest, after: frozen.digest, ...(retainsClaim ? { retainedClaim: true } : {}) };
  });
}



export { listItems } from './board-query.js';

export { itemsInStatus } from './board-query.js';


export { getItem } from './board-query.js';

/**
 * Insert a shout within the caller's transaction.
 *
 * @param {any} board
 * @param {{ from: string, to: string, text: string, lanes: string[], item?: number, decision?: boolean, answers?: number | null, evidence?: any, request?: boolean, news?: boolean, channel?: 'terminal' | 'view', detail?: object }} message - detail: extra event fields
 * @returns {number}
 */
function insertShout(board, { from, to, text, lanes, item, decision = false, answers = null, evidence = null, request = false, news = false, channel = 'terminal', detail = {}, options }) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  const validatedDecision = itemDecisions.itemDecisionDetail(board, { options, decision, item, from }, engine);
  detail = { ...detail, ...validatedDecision };
  if (item !== undefined) {
    if (engine < ITEM_SHOUT_ENGINE) throw new Refused('ENGINE_VERSION', 'item messages require engine 93; upgrade every linked device before sending one');
    to = itemShoutTarget(board.db, item);
    detail = { ...detail, item, text: text.trim() };
  }
  const coordinationOnly = engine >= ITEM_SHOUT_ENGINE && to === 'all' && from !== COORDINATOR && from !== PERSON
    && Boolean(board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(from));
  if (coordinationOnly) to = COORDINATION_SHOUT;
  if (!text.trim()) throw new Refused('EMPTY_SHOUT', 'a shout needs text');
  if (to === from) throw new Refused('SELF_SHOUT', `a shout cannot be addressed to its sender ${from}; name another agent, a lane or all`);
  if (request && (from !== 'person' || to !== COORDINATOR || decision || answers !== null)) {
    throw new Refused('BAD_REQUEST', 'a request goes from the person to the coordinator; use the board requests endpoint with its text');
  }
  const ask = answers === null ? null : getShout(board, answers);
  const isAgent = board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(to);
  const requestReply = ask?.shout_request && to === ask.shout_from;
  if (item === undefined && !coordinationOnly && to !== 'all' && to !== PERSON && !lanes.includes(to) && !isAgent && !requestReply) {
    throw new Refused('NO_READER', `nobody reads "${to}": name a lane, an agent or all`);
  }
  if (to === PERSON && decision && from !== COORDINATOR) {
    throw new Refused('B26_PERSON_DECISION', `only the coordinator can ask the person for a decision; ask your coordinator: pullboard shout coordinator "${text.trim()}" --decision`);
  }
  let outcome = '';
  if (ask?.shout_request) {
    if (from !== COORDINATOR || !requestReply) throw new Refused('COORDINATOR_ONLY', `only the coordinator answers request #${answers}; ask the coordinator to run pullboard answer ${answers} done or declined <reason>`);
    if (board.db.prepare('SELECT 1 FROM shout WHERE shout_answers = ? AND shout_request_outcome != ?').get(answers, '')) {
      throw new Refused('REQUEST_CLOSED', `request #${answers} was already answered; read pullboard inbox before answering another request`);
    }
    const reply = /^(done|declined)(?:\s+([\s\S]+))?$/.exec(text.trim());
    if (!reply || (reply[1] === 'declined' && !reply[2]?.trim())) {
      throw new Refused('REQUEST_OUTCOME', `answer request #${answers} with done or declined followed by a reason: pullboard answer ${answers} done or declined <reason>`);
    }
    outcome = reply[1];
  } else if (ask && !ask.shout_decision) {
    throw new Refused('NOT_A_DECISION', `shout #${answers} asked for no decision; reply with pullboard shout`);
  }
  if (evidence) checkEvidence(board, evidence);
  const personAnswer = from === PERSON && answers !== null && !decision;
  if (personAnswer && !['terminal', 'view'].includes(channel)) {
    throw new Refused('B26_PERSON_CHANNEL', 'record the person answer through the terminal or the view; run pullboard view');
  }
  return persistShout(board, { from, to, text, decision, answers, evidence, request, news, channel, detail, outcome, personAnswer, decisionRecord: validatedDecision.decisionOptions ? { item, options: validatedDecision.decisionOptions } : null });
}

/** Persist a validated message or a fixed internal notice inside the caller's transaction. */
function persistShout(board, { from, to, text, decision = false, answers = null, evidence = null, request = false,
  channel = 'terminal', detail = {}, outcome = '', personAnswer = false, decisionRecord = null, news = false }) {
  const result = board.db
    .prepare(
      `INSERT INTO shout (shout_from, shout_to, shout_text, shout_at, shout_decision, shout_answers,
         shout_evidence_kind, shout_evidence_outcome, shout_evidence_item, shout_evidence_commit,
         shout_request, shout_request_outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(from, to, text.trim(), now(board), decision ? 1 : 0, answers, evidence?.kind ?? null, evidence ? evidence.outcome.trim() : null, evidence?.item ?? null, evidence?.commit ?? null, request ? 1 : 0, outcome);
  const id = Number(result.lastInsertRowid);
  logEvent(board, from, answers === null ? (news ? 'shout_news' : 'shout') : decision ? 'pass' : 'answer', detail.item ?? null, { shout: id, to, decision: Boolean(decision), request: Boolean(request), answers, ...(outcome ? { outcome } : {}), ...(personAnswer ? { channel } : {}), ...detail });
  itemDecisions.recordItemDecision(board, id, { decision, answers, record: decisionRecord });
  return id;
}

/**
 * Shout to a lane, an agent, `all`, or the person (B7, B25, B26). The caller passes declared lanes.
 *
 * @param {any} board
 * @param {{ from: string, to: string, text: string, lanes: string[], item?: number, decision?: boolean, answers?: number | null, evidence?: any, request?: boolean, news?: boolean, channel?: 'terminal' | 'view' }} message
 * @returns {number}
 */
export function shout(board, message) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= PROOF_RUN_ENGINE) refuseLongShout(message.text);
  return atomic(board, () => insertShout(board, routeLaneMessage(board, { ...message,
    news: activityNewsFlag(message, board.executionEngineVersion ?? ENGINE_VERSION) }, board.executionEngineVersion ?? ENGINE_VERSION)));
}

/** Record one health snapshot through its unchanged transactional implementation [A6]. */
export function recordHealthFindings(board, options) {
  return applyHealthFindings(board, options, { atomic, insertShout });
}

/**
 * Pass an open coordinator decision to the person with the original question and note (B27).
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, note: string, lanes: string[] }} options
 * @returns {number}
 */
export function passDecision(board, id, { agentId, note, lanes }) {
  return atomic(board, () => {
    const ask = getShout(board, id);
    const laneEscalation = leadOwnsDecision(board, ask, agentId);
    if (agentId !== COORDINATOR && !laneEscalation) throw new Refused('COORDINATOR_ONLY', 'only the coordinator or the addressed lane lead can pass a decision up');
    if (!ask.shout_decision || (!laneEscalation && ask.shout_to !== COORDINATOR && ask.shout_to !== COORDINATION_SHOUT && shoutItemId(ask.shout_to) === null)) throw new Refused('NOT_COORDINATOR_DECISION', `shout #${id} is not a decision waiting for the coordinator`);
    if (board.db.prepare('SELECT 1 FROM shout WHERE shout_answers = ?').get(id)) throw new Refused('ALREADY_ANSWERED', `shout #${id} already has an answer`);
    const text = `Passed up from ${ask.shout_from}: ${ask.shout_text}\nCoordinator note: ${String(note ?? '').trim()}`;
    if (!String(note ?? '').trim()) throw new Refused('EMPTY_NOTE', 'include a note with the reason for passing this decision');
    return insertShout(board, { from: agentId, to: laneEscalation ? COORDINATOR : PERSON, text, lanes, decision: true, answers: id, detail: shoutItemId(ask.shout_to) === null ? {} : { item: shoutItemId(ask.shout_to), text } });
  });
}

/**
 * Answer an open decision addressed to the caller, delivering passed-up answers to the asker (B27).
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, text: string, lanes: string[], asPerson?: boolean, channel?: 'terminal' | 'view', implies?: number[], supersedes?: number | null, impliesId?: string, origin?: string, rationale?: string }} options - implies and supersedes tell items (B29,B31); origin and rationale record where the decision came from (N29)
 * @returns {number}
 */
export function answerDecision(board, id, { agentId, text, lanes, asPerson = false, channel = 'terminal', implies, supersedes = null, impliesId, origin, rationale }) {
  return atomic(board, () => {
    const ask = getShout(board, id);
    if (ask.shout_request) {
      if (asPerson || implies?.length || supersedes !== null) throw requestAnswerRefusal(id, { asPerson });
      return insertShout(board, { from: agentId, to: ask.shout_from, text, lanes, answers: id });
    }
    if (!ask.shout_decision) throw new Refused('NOT_A_DECISION', `shout #${id} asked for no decision`);
    if (board.db.prepare('SELECT 1 FROM shout WHERE shout_answers = ?').get(id)) throw new Refused('ALREADY_ANSWERED', `shout #${id} already has an answer`);
    if (asPerson && agentId !== COORDINATOR) throw new Refused('B26_PERSON_ANSWER', `only the main checkout can answer as the person; ask your coordinator: pullboard answer ${id} "<answer>"`);
    if (asPerson && ask.shout_to !== PERSON) throw new Refused('B26_PERSON_ANSWER', `person mode answers only decisions addressed to the person; the coordinator answers this one: pullboard answer ${id} "<answer>"`);
    if (!asPerson && ask.shout_to === PERSON && agentId === COORDINATOR) throw new Refused('B26_PERSON_ANSWER', `this decision is addressed to the person; answer from the main checkout: pullboard answer ${id} "<answer>" --as person`);
    const personAnswer = asPerson;
    const caller = personAnswer ? null : board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id = ?').get(agentId);
    const addressedItem = shoutItemId(ask.shout_to);
    const ownsDecision = ask.shout_to === agentId || ask.shout_to === caller?.agent_lane
      || (ask.shout_to === COORDINATION_SHOUT && agentId === COORDINATOR)
      || (addressedItem !== null && itemShoutReader(board.db, addressedItem, agentId));
    if (!ownsDecision && !personAnswer) {
      const lane = caller?.agent_lane ? `your ${caller.agent_lane} lane` : 'a lane you do not belong to';
      throw new Refused('NOT_YOUR_DECISION', `shout #${id} is addressed to ${ask.shout_to}, not ${lane} (agent ${agentId})`);
    }
    const from = personAnswer ? PERSON : agentId;
    const provenance = answerProvenance(board, { agentId, asPerson: personAnswer, text, origin, rationale });
    if (!personAnswer && leadOwnsDecision(board, ask, agentId)) insertShout(board, { from, to: COORDINATOR, text: `Lane decision #${id}: ${String(text).trim()}`, lanes, detail: { messageKind: 'decision' } });
    const answerId = tellAnswerImplications(board, (by, itemId, fact) => logEvent(board, by, 'fact', itemId, fact), insertShout(board, { from, to: ask.shout_from, text, lanes, answers: id, channel, ...(addressedItem === null ? {} : { item: addressedItem }), detail: { ...(implies?.length ? { implies } : {}), ...(supersedes !== null ? { supersedes } : {}), ...(provenance ? { provenance } : {}) } }), { seed: impliesId, implies, supersedes, from, person: PERSON });
    if ((personAnswer || agentId === COORDINATOR && isLaneEscalation(board, ask)) && ask.shout_answers !== null) {
      const original = getShout(board, ask.shout_answers);
      insertShout(board, { from, to: original.shout_from, text: `${personAnswer ? 'Person' : 'Coordinator'} answered #${id}: ${String(text).trim()}`, lanes, answers: original.shout_id, channel, ...(shoutItemId(original.shout_to) === null ? {} : { item: shoutItemId(original.shout_to) }) });
    }
    return answerId;
  });
}

/** The kinds of evidence a shout can carry (B22): what was tried, or what was measured. */
export const EVIDENCE_KINDS = ['attempt', 'receipt'];

/**
 * Refuse evidence that is not fields a reader can trust (B22): its kind, its outcome, an item on
 * the board, and a full commit SHA, which the CLI resolves in the repo before it gets here.
 *
 * @param {any} board
 * @param {{ kind: string, outcome: string, item: number, commit: string }} evidence
 */
function checkEvidence(board, { kind, outcome, item, commit }) {
  if (!EVIDENCE_KINDS.includes(kind)) throw new Refused('BAD_EVIDENCE', `the evidence kind is attempt or receipt, not "${kind ?? ''}": --evidence receipt`);
  if (!String(outcome ?? '').trim()) throw new Refused('BAD_EVIDENCE', 'evidence names its outcome: --outcome measured');
  if (!Number.isInteger(item) || !board.db.prepare('SELECT 1 FROM item WHERE item_id = ?').get(item)) {
    throw new Refused('BAD_EVIDENCE', `evidence names an item on the board: --item <id> (saw ${item})`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Refused('BAD_EVIDENCE', `evidence names a commit by its full SHA (saw "${commit ?? ''}")`);
}




export { openDecisions } from './board-query.js';


export { inbox } from './inbox-store.js';

export { unreadCount } from './board-query.js';

export { events } from './board-query.js';

export { FACT_KINDS } from './item-notes.js';
const FACT_JUDGEMENTS = new Set(['decision', 'rejection', 'supersession', 'root-cause']);
export { factReference };

export { itemThread } from './board-query.js';


/** Append a typed fact atomically; a correction never edits the original event [B29,B30,B31,B32].
 * The internal factId is set from a sealed move's identity during replay, rather than replica-local sequence ids; a never-again with its cause is the person's alone, and rigor lists it at once (#713) [D1].
 */
export function appendFact(board, id, { agentId, kind, text, ref = null, supersedes = null, answers = null, factId = randomUUID(), implies, cause = null, neverAgain = false, asPerson = false, channel = 'terminal' }) {
  if (board.readOnly) requireFactIdentityIndexes(board.db);
  return atomic(board, () => {
    const item = current(board, itemById(board, id));
    if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(agentId)) throw new Refused('NO_AGENT', `no registered agent ${agentId}; join a worktree before appending a fact`);
    requireFactKind(board, kind);
    if (typeof text !== 'string' || !text.trim()) throw new Refused('EMPTY_FACT', 'a fact needs nonempty text; supply the observation or judgement');
    const barFields = barCheckFactFields(board, item, { agentId, kind, text, answers, supersedes });
    if ((FACT_JUDGEMENTS.has(kind) || supersedes !== null) && agentId !== COORDINATOR && (!isHeld(board, item) || item.item_owner !== agentId)) {
      throw new Refused('FACT_JUDGEMENT', `only the item's live holder${isHeld(board, item) ? ' (' + item.item_owner + ')' : ''} or the coordinator may append a judgement or supersede a fact; append an observation or ask the coordinator`);
    }
    if (typeof factId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(factId)) throw new Refused('BAD_FACT_ID', 'a fact identity is invalid; retry with the current Pullboard engine');
    if (factIdentityExists(board.db, factId)) throw new Refused('BAD_FACT_ID', 'this fact identity is already recorded; retry the original sealed move instead of appending it again');
    if (supersedes !== null && (typeof supersedes !== 'string' || !itemThread(board, id).some((entry) => entry.type === 'fact' && entry.id === supersedes))) {
      throw new Refused('NO_FACT', `no fact ${String(supersedes)} on item #${id}; use a fact id from pullboard show ${id} --json`);
    }
    const binding = factReference(ref);
    if (neverAgain || asPerson || cause !== null) requireNeverAgain(id, { agentId, cause, neverAgain, asPerson, channel });
    logEvent(board, neverAgain ? PERSON : agentId, 'fact', id, { id: factId, kind, text, ref: binding, supersedes, ...barFields, ...(neverAgain ? { cause, neverAgain: true, channel } : {}), ...(implies?.length ? { implies } : {}) });
    const trigger = board.lastEvent;
    const result = tellFactImplications(board, (by, itemId, fact) => logEvent(board, by, 'fact', itemId, fact), factFromEvent(trigger), { id, implies, supersedes });
    if (neverAgain) postRigorNotices(board, trigger);
    return result;
  });
}

/** The enclosing move's transaction owns these implicit notices; older replay emits none. */
function postRigorNotices(board, trigger) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < RIGOR_NOTICE_ENGINE) return;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= RIGOR_AUTO_ENGINE) {
    recordAutomaticRigorDrafts(board, trigger, persistShout);
    return;
  }
  for (const cause of newRigorNotices(events(board), trigger, { person: PERSON })) {
    persistShout(board, { from: 'rigor', to: COORDINATOR, text: rigorNoticeText(cause) });
    logEvent(board, 'rigor', 'rigor-notice', null, { cause: cause.key, items: cause.items,
      occurrences: cause.occurrences, neverAgain: cause.neverAgain, engine: RIGOR_NOTICE_ENGINE });
  }
}


/** Share milestone policy, primary computed order and equal-score path ties across queue and health. */
export function buildOrder(board, { warm = [], agentId, readiness = barReadyForOrder, releasedClaims = [], tierFirst = false, priority } = {}) {
  const milestonePriority = priority ?? milestonePriorities(board);
  const items = listItems(board, { all: true });
  const rank = milestoneRanks(board, milestonePriority);
  const recent = new Set(warm);
  const shared = entry => itemFiles(entry).filter(path => recent.has(path)).length;
  const focus = milestoneFocus(board);
  const group = item => focus?.ids.has(item.item_id) ? -1 : milestonePriority(item);
  const paths = criticalPathEnabled(board) ? remainingPaths(items, group) : new Map();
  const tieBreak = (first, second) => (paths.get(second.item_id) ?? 0) - (paths.get(first.item_id) ?? 0);
  const fallback = workOrderCompare(board, { priority: milestonePriority, rank, shared, tierFirst, tieBreak }) ?? ((first, second) => milestonePriority(first) - milestonePriority(second)
    || rank(first) - rank(second)
    || ROUTES.indexOf(second.item_route) - ROUTES.indexOf(first.item_route)
    || shared(second) - shared(first) || first.item_id - second.item_id);
  return focusOrder(board, lineOrderEnabled(board)
    ? lineBuildOrder({ agentId, release: milestonePriority, rank, items, ready: item => readiness(board, item), fallback }) : fallback);
}

/**
 * The next item an agent can take (N2): for a builder, the oldest open item in its lane whose
 * dependencies are verified; for a verifier, the oldest submitted item it did not build. An agent
 * sees items at its tier and below, its own tier first, so lighter work waits for lighter models
 * while there is heavier work to do (B13). When nothing is free, the reasons say what everything
 * is waiting on.
 *
 * With `runnable`, only items that carry a check command, which an unattended runner needs; with
 * `routes`, only items on those routes, the ones a runner has an agent command for. With `warm`, the
 * files the agent worked in lately, an item that shares more of them comes first within its tier,
 * and `shared` names them (N20). A held lane offers nothing new (N22). A verifier is never offered `skipIds` (#973; engine 69, so older replays carry none).
 *
 * @param {any} board
 * @param {{ agentId: string, lane: string, verify?: boolean, policy?: string, familyPolicy?: string, runnable?: boolean, routes?: string[], warm?: string[], priority?: number[], lanes?: string[], skipIds?: number[] }} who
 * @returns {{ item: any | null, reasons: string[], shared?: string[] }}
 */
export function nextFor(board, { agentId, lane, verify = false, policy = 'any', familyPolicy = 'off', runnable = false, routes = ROUTES, warm = [], priority = [], lanes, skipIds = [] }) {
  const focusCompare = focusOrder(board, () => 0);
  const route = routeOf(board, agentId);
  const tier = (entry) => ROUTES.indexOf(entry.item_route);
  const allItems = listItems(board).reverse();
  const items = allItems
    .filter((entry) => canTake(route, entry.item_route) && routes.includes(entry.item_route) && (!runnable || entry.item_check))
    .sort((first, second) => tier(second) - tier(first));
  const tiers = route === 'strong' ? '' : `${ROUTES.slice(0, ROUTES.indexOf(route) + 1).reverse().join(' or ')} `;
  const routed = `${tiers}${runnable ? 'runnable ' : ''}`;
  if (verify) {
    const family = board.db.prepare('SELECT agent_family FROM agent WHERE agent_id = ?').get(agentId)?.agent_family ?? null;
    const hasDifferentFamily = (entry) => Boolean(family && entry.item_builder_family && family !== entry.item_builder_family);
    const unrelated = items.filter((entry) => entry.item_status === 'submitted' && entry.item_built_by !== agentId && !skipIds.includes(entry.item_id));
    const standingRefusal = unrelated.map((entry) => itemAuthorProblem(board, entry, agentId)).find(Boolean);
    let reviewable = unrelated.filter((entry) => !itemAuthorProblem(board, entry, agentId));
    if (policy === COORDINATOR && agentId !== COORDINATOR) reviewable = reviewable.filter((entry) => entry.item_lane === COORDINATOR);
    if (familyPolicy === 'require') reviewable = reviewable.filter(hasDifferentFamily);
    if (familyPolicy === 'prefer') reviewable.sort((first, second) => Number(hasDifferentFamily(second)) - Number(hasDifferentFamily(first)));
    const candidates = reviewable.map((entry) => ({
      entry,
      holder: reviewHolder(board, entry),
      cooldown: reviewReleaseCooldown(board, entry.item_id, agentId),
    }));
    const heldByMe = candidates.find((candidate) => candidate.holder === agentId)?.entry;
    if (heldByMe) return { item: heldByMe, reasons: [] };
    const milestonePriority = milestonePriorities(board);
    const rank = milestoneRanks(board, milestonePriority);
    const scarcity = lineOrderEnabled(board) ? reviewerScarcity(board, candidates.map(candidate => candidate.entry), (entry, reviewer) =>
      Object.values(reviewerChecks(board, { agentId: reviewer, policy, familyPolicy })).every(guard => !guard(entry))) : null;
    const lineCompare = scarcity ? buildOrder(board, { agentId }) : null;
    const previousOrder = (first, second) => scarcity ? scarcity.get(first.item_id) - scarcity.get(second.item_id)
      || lineCompare(first, second) : milestonePriority(first) - milestonePriority(second)
      || rank(first) - rank(second);
    const focus = milestoneFocus(board);
    const group = item => focus?.ids.has(item.item_id) ? -1 : milestonePriority(item);
    const order = criticalPathEnabled(board) ? criticalPathOrder({ items: listItems(board, { all: true }), group, fallback: previousOrder }) : previousOrder;
    candidates.sort((first, second) => order(first.entry, second.entry));
    candidates.sort((a, b) => focusCompare(a.entry, b.entry));
    const item = candidates.find((candidate) => !candidate.holder && !candidate.cooldown)?.entry;
    if (item) return { item, reasons: focusReasons(board, item) };
    const held = candidates.filter((candidate) => candidate.holder && candidate.holder !== agentId)
      .map(({ entry, holder: reviewer }) => `${reviewer} holds the review of #${entry.item_id} until ${entry.item_review_until}`);
    const cooling = candidates.filter((candidate) => candidate.cooldown)
      .map(({ entry, cooldown }) => `you released the review of #${entry.item_id}; try again after ${cooldown}, or let another reviewer take it`);
    return { item: null, reasons: [`nothing ${routed}submitted that you did not build${held.length ? ' and no other agent is reviewing' : ''}`,
      ...(standingRefusal ? [standingRefusal.message] : []), ...held, ...cooling] };
  }
  const held = items.find((entry) => entry.item_status === 'claimed' && entry.item_owner === agentId && entry.item_parent_id === null);
  if (held) return { item: held, reasons: [] };
  const selectedLanes = new Set(lanes ?? [lane]);
  const reasons = allItems.filter((entry) => entry.item_status === 'open' && selectedLanes.has(entry.item_lane) && entry.item_hold_reason)
    .map((entry) => `#${entry.item_id} is held by coordinator: ${entry.item_hold_reason}`);
  const paused = laneHold(board, lane);
  if (!lanes && paused) return { item: null, reasons: [`${paused.hold_by} holds the ${lane} lane: ${paused.hold_reason}`, ...reasons] };
  if (lanes) for (const name of selectedLanes) {
    const hold = laneHold(board, name);
    if (hold) { selectedLanes.delete(name); reasons.push(`${hold.hold_by} holds the ${name} lane: ${hold.hold_reason}`); }
  }
  const compare = buildOrder(board, { warm, agentId, tierFirst: true });
  const inFlight = listItems(board, { all: true });
  const recent = new Set(warm);
  const mainRed = new Set(priority);
  const laneItems = items.filter((entry) => entry.item_status === 'open' && selectedLanes.has(entry.item_lane));
  const mine = laneItems
    .filter((entry) => !itemHold(board, entry.item_id))
    .map((entry, order) => ({ entry, order, shared: itemFiles(entry).filter((path) => recent.has(path)) }))
    .sort((first, second) => compare(first.entry, second.entry));
  // Move only evidenced reworks ahead of their own tier; with no evidence, normal order is exact.
  for (const route of lineOrderEnabled(board) ? [] : ROUTES) {
    const routeTier = ROUTES.indexOf(route);
    const selected = mine.findIndex(({ entry }) => tier(entry) === routeTier && mainRed.has(entry.item_id));
    const firstTierItem = mine.findIndex(({ entry }) => tier(entry) === routeTier);
    if (selected > firstTierItem && firstTierItem >= 0) {
      // Explicit coordinator order leads automatic rework; never-ranked boards retain their old path.
      if ((board.executionEngineVersion ?? ENGINE_VERSION) >= MILESTONE_RANK_ENGINE && milestones(board).some(entry => entry.order?.length)) {
        const position = milestonePriorities(board);
        const rank = milestoneRanks(board, position);
        const first = mine[firstTierItem].entry;
        const selectedItem = mine[selected].entry;
        if (position(first) !== position(selectedItem) || rank(first) !== rank(selectedItem)) continue;
      }
      const [rework] = mine.splice(selected, 1);
      mine.splice(firstTierItem, 0, rework);
    }
  }
  mine.sort((a, b) => focusCompare(a.entry, b.entry));
  for (const { entry, shared } of mine) {
    const waiting = itemDependencies.localDependencyIds(entry)
      .map((id) => current(board, itemById(board, id)))
      .filter((before) => before.item_status !== 'verified');
    const reserved = firstRefusalReason(board, entry.item_id, agentId);
    if (reserved) { reasons.push(reserved); continue; }
    const collisions = itemFileCollisions(entry, inFlight);
    if (collisions.length) { reasons.push(...collisions); continue; }
    const foreign = foreignBlockers(board, entry);
    if (foreign.length) {
      reasons.push(`#${entry.item_id} waits on ${foreign.map(ref => `${itemDependencies.dependencyLabel(ref)} (${ref.status} on its own board)`).join(', ')}`);
      continue;
    }
    if (!waiting.length) return { item: entry, reasons: focusReasons(board, entry,
      [...reasons, ...collisions.map(reason => reason.replace(' waits for ', ' overlaps with '))]), shared };
    reasons.push(`#${entry.item_id} waits on ${waiting.map(waitingOn).join(', ')}`);
  }
  if (!mine.length && !reasons.length) reasons.push(idleReason(items, lane, routed));
  // Nothing to claim, yet work above the agent's tier is open: name it and the ways through (B16).
  for (const entry of listItems(board).filter((open) => open.item_status === 'open' && open.item_lane === lane && !open.item_hold_reason && !canTake(route, open.item_route))) {
    reasons.push(`#${entry.item_id} (${entry.item_route}) is open in the ${lane} lane, above your ${route} route: a ${entry.item_route} agent takes it, or, if ${route} can build it, the coordinator reroutes it: pullboard edit ${entry.item_id} --route ${route}`);
  }
  return { item: null, reasons };
}

/**
 * An item something waits on, as the waiting agent needs it: its state, whether a verifier sent it
 * back, and the lane to shout.
 *
 * @param {any} item
 * @returns {string}
 */
function waitingOn(item) {
  const rejected = item.item_status === 'open' && item.item_verdict === 'REJECT' ? ', rejected' : '';
  return `#${item.item_id} (${item.item_status}${rejected}, ${item.item_lane} lane)`;
}

/**
 * Why a lane has nothing to claim (N13): a lane whose items still await verdicts is not done, since
 * a rejected item comes back to it; the coordinator builds only its own lane's items.
 *
 * @param {any[]} items - Items not yet verified or withdrawn, as the agent may see them.
 * @param {string} lane
 * @param {string} routed
 * @returns {string}
 */
function idleReason(items, lane, routed) {
  const reason = `no open ${routed}items in the ${lane} lane`;
  if (lane === COORDINATOR) return `${reason}; lane items are built from each lane's own worktree`;
  const awaiting = items.filter((entry) => entry.item_lane === lane && entry.item_status === 'submitted').map((entry) => `#${entry.item_id}`);
  if (!awaiting.length) return reason;
  return `${reason}; ${awaiting.join(', ')} still await${awaiting.length === 1 ? 's' : ''} a verdict, and a rejected item comes back to this lane. A lane is done when its items are verified`;
}

export { relatedItems } from './board-query.js';

/**
 * Hold a lane (N22): `next` there claims nothing and names the reason, so a pause lives on the board
 * and not in a message. Work already claimed goes on. Only the coordinator holds and releases.
 *
 * @param {any} board
 * @param {string} lane
 * @param {{ agentId: string, reason: string, asPerson?: boolean, channel?: string }} hold
 */
export function holdLane(board, lane, { agentId, reason, asPerson = false, channel = 'terminal' }) {
  coordinatorOnly(agentId, 'holds a lane');
  if (asPerson && !['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'record the person hold through the terminal or the view; run pullboard view');
  const by = asPerson ? PERSON : agentId;
  if (!String(reason ?? '').trim()) throw new Refused('USAGE', `a hold needs a reason: pullboard hold ${lane} --reason "why"`);
  atomic(board, () => {
    board.db
      .prepare(
        `INSERT INTO hold (hold_lane, hold_reason, hold_by, hold_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (hold_lane) DO UPDATE SET hold_reason = excluded.hold_reason, hold_by = excluded.hold_by, hold_at = excluded.hold_at`,
      )
      .run(lane, reason.trim(), by, now(board));
    logEvent(board, by, 'hold', null, { lane, reason: reason.trim(), ...(asPerson ? { channel } : {}) });
  });
}

/**
 * Release a held lane.
 *
 * @param {any} board
 * @param {string} lane
 * @param {{ agentId: string, asPerson?: boolean, channel?: string }} who
 */
export function releaseLane(board, lane, { agentId, asPerson = false, channel = 'terminal' }) {
  coordinatorOnly(agentId, 'releases a lane');
  if (asPerson && !['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'record the person release through the terminal or the view; run pullboard view');
  const by = asPerson ? PERSON : agentId;
  atomic(board, () => {
    const { changes } = board.db.prepare('DELETE FROM hold WHERE hold_lane = ?').run(lane);
    if (!changes) throw new Refused('NOT_HELD', `the ${lane} lane is not held`);
    logEvent(board, by, 'unhold', null, { lane, ...(asPerson ? { channel } : {}) });
  });
}

export { laneHold, laneHolds } from './board-query.js';

export { itemHold } from './board-query.js';

/** Hold an open or already-claimed item without changing its current lifecycle state. */
export function holdItem(board, id, { agentId, reason }) {
  coordinatorOnly(agentId, 'holds an item');
  const text = String(reason ?? '').trim();
  if (!text) throw new Refused('USAGE', `a hold needs a reason: pullboard hold ${id} "why"`);
  return atomic(board, () => {
    const item = getItem(board, id);
    if (!['open', 'claimed'].includes(item.item_status)) {
      throw new Refused('ITEM_NOT_OPEN', `item #${id} is ${item.item_status}; only open or claimed items can be held`);
    }
    const at = now(board);
    setItem(board, id, { item_hold_reason: text, item_hold_by: agentId, item_hold_at: at });
    logEvent(board, agentId, 'hold_item', id, { reason: text });
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= RIGOR_AUTO_ENGINE) postRigorNotices(board, board.lastEvent);
    return itemHold(board, id);
  });
}

/** Lift an item's coordinator hold without changing any other item state. */
export function releaseItemHold(board, id, { agentId }) {
  coordinatorOnly(agentId, 'lifts an item hold');
  return atomic(board, () => {
    const held = itemHold(board, id);
    if (!held) throw new Refused('NOT_HELD', `item #${id} is not held`);
    setItem(board, id, { item_hold_reason: null, item_hold_by: null, item_hold_at: null });
    logEvent(board, agentId, 'unhold_item', id, { reason: held.item_hold_reason });
  });
}


// A lane agent's drafted rows live in row-drafts.js (#878); exported here so the engine dispatches them.
export { draftSpecRow, rowDrafts } from './row-drafts.js';
export { recordSpecApprovalBaseline, specApprovalBaseline, specApprovalBaselineExists } from './spec-approval-baseline.js';
// The roadmap's moves live in milestones.js; the board keeps exporting them so the engine replays them.
export { addMilestone, canonicalMilestoneTarget, editMilestone, editMilestoneItems, orderMilestoneItems, moveMilestone, removeMilestone, roadmap, shipMilestone } from './milestones.js';

export { rowDecisions } from './board-query.js';

/** Persist the current decision index inside its caller's board transaction. */
function writeRowDecisions(board, records) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run('row_decisions', JSON.stringify(records));
}

/** Record one exact-row decision per event; sender-side channel checks precede deterministic replay. */
export function recordRowDecisions(board, { agentId, channel, decisions }) {
  if (agentId !== PERSON) throw new Refused('B26_PERSON_APPROVAL', 'only the person approves or declines rows; use pullboard view for the person to decide');
  if (!['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'row decisions use the terminal or the view; use pullboard view');
  if (!Array.isArray(decisions) || !decisions.length) throw new Refused('ROW_DECISION', 'name at least one row to approve or decline; use pullboard spec approve <ids>');
  const keys = new Set();
  for (const record of decisions) {
    if (!record || !['approve', 'decline'].includes(record.decision) || !['spec', 'doctrine'].includes(record.kind)
      || !['id', 'file', 'source', 'replacement', 'text'].every((key) => typeof record[key] === 'string' && record[key].trim())
      || (record.decision === 'decline' && !String(record.reason ?? '').trim())) throw new Refused('ROW_DECISION', 'a row decision needs its id, file and exact text; use pullboard spec approve or decline');
    const original = parseSpec(`## Decision\n${record.source}\n`).rows;
    const replacement = parseSpec(`## Decision\n${record.replacement}\n`).rows;
    const target = replacement[0];
    const engineVersion = board.executionEngineVersion ?? ENGINE_VERSION;
    const validDeclineText = record.decision !== 'decline' || (engineVersion >= 12
      ? record.text === original[0]?.text
      : target?.text === record.reason);
    const revision = record.revision !== undefined && engineVersion >= SPEC_REVISION_ENGINE && validRevisionApproval(board, record);
    if (!revision && (record.revision !== undefined || original.length !== 1 || original[0].id !== record.id || replacement.length !== 1 || target.id !== record.id
      || target.status !== (record.decision === 'approve' ? 'approved' : 'wont') || target.text !== record.text
      || !validDeclineText)) throw new Refused('ROW_DECISION', 'the exact row must match its recorded approval or decline; use pullboard spec approve or decline');
    const key = `${record.kind}:${record.id}`;
    if (keys.has(key)) throw new Refused('ROW_DECISION', `${key} is named twice; use each row once`);
    keys.add(key);
  }
  return atomic(board, () => {
    let current = rowDecisions(board);
    const recorded = decisions.map((record) => {
      logEvent(board, PERSON, 'row_decision', null, { record, channel });
      const entry = { ...record, event: board.lastEvent.event_id, at: board.lastEvent.event_at, applied: false };
      current = [...current.filter((old) => old.kind !== record.kind || old.id !== record.id), entry];
      return entry;
    });
    writeRowDecisions(board, current);
    return recorded;
  });
}

/** A coordinator records which exact decisions its local file changes applied, with no replay writes. */
export function applyRowDecisions(board, { agentId, events }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator applies row decisions; ask your coordinator to run pullboard spec apply');
  if (!Array.isArray(events) || events.some((event) => !Number.isSafeInteger(event) || event < 1)) throw new Refused('ROW_DECISION', 'apply needs current decision event ids; use pullboard spec apply');
  return atomic(board, () => {
    const records = rowDecisions(board);
    const found = events.map((event) => records.find((record) => record.event === event));
    if (found.some((record) => !record)) throw new Refused('STALE_ROW_DECISION', 'a row decision was replaced; use pullboard spec apply with the current decisions');
    const applied = found.filter((record) => !record.applied);
    if (!applied.length) return [];
    const at = now(board);
    writeRowDecisions(board, records.map((record) => events.includes(record.event) ? { ...record, applied: true, appliedAt: at } : record));
    markAppliedRevisions(board, applied, at);
    logEvent(board, agentId, 'row_apply', null, { events: applied.map((record) => record.event) });
    return applied.map((record) => ({ ...record, applied: true, appliedAt: at }));
  });
}


export { recentShouts, eventsOfKinds, recentEvents, lastMoves, decisionAndEvidenceShouts, submitInvariantEvents } from './board-hot.js';

export { stats } from './board-stats.js';

export { landingBatches };

/** Append one coordinator-owned batch revision without changing the board schema [B3,R3]. */
export function recordLandingBatch(board, { agentId, batch, revision = 0, landingFence }) {
  coordinatorOnly(agentId, 'records landing batches');
  landingEnvironment.requireBatch(board, batch);
  if (carriesFlakeDiagnostics(batch) && (board.executionEngineVersion ?? ENGINE_VERSION) < NATIVE_FLAKE_ENGINE) {
    throw new Refused('ENGINE_VERSION', `typed landing diagnostics require engine ${NATIVE_FLAKE_ENGINE}; upgrade Pullboard`);
  }
  if (batch?.state === 'trunk' && (board.executionEngineVersion ?? ENGINE_VERSION) < LOCAL_LANDING_ENGINE) throw new Refused('ENGINE_VERSION', `landing on the local trunk requires engine ${LOCAL_LANDING_ENGINE}; upgrade Pullboard`);
  const evidence = (board.executionEngineVersion ?? ENGINE_VERSION) >= SUBMISSION_PROOF_ENGINE ? invariantEvidence(batch?.invariantEvidence) : undefined;
  validateLandingBatch(batch, revision);
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= VERDICT_REVIEW_ENGINE
    && batch.items.some(entry => Object.hasOwn(entry, 'reviewedCommit') && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(entry.reviewedCommit ?? ''))) {
    throw new Refused('LAND_BATCH', 'a landing batch needs its exact base, tip, items, state, owner and log path; run pullboard land');
  }
  return atomic(board, () => {
    guardLandingWrite(board, landingFence);
    const previous = landingBatches(board).find((entry) => entry.id === batch.id);
    landingEnvironment.requireRevision(board, previous, batch);
    preserveInvariantEvidence(previous, evidence, board.executionEngineVersion ?? ENGINE_VERSION);
    validateLandingRevision(previous, batch, revision);
    const recorded = { ...batch, revision: revision + 1, updatedAt: now(board) };
    delete recorded.invariantEvidence;
    if (evidence) recorded.invariantEvidence = evidence;
    logEvent(board, agentId, 'landing_batch', null, { batch: recorded });
    return recorded;
  });
}

/** Record the person's expiring exception for one named failing test [B3,R3]. */
export function recordLandingWaiver(board, { agentId, channel, id, test, until, reason }) {
  if (agentId !== PERSON) throw new Refused('LAND_PERSON_ONLY', 'only the person waives a flaky test; use the person’s terminal or Pullboard View');
  if (!['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'waivers use the person’s terminal or view; run pullboard view');
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(id) || typeof test !== 'string' || !test.trim()
    || test.startsWith('/') || test.includes('\\') || test.split('/').some((part) => !part || part === '..' || part === '.')
    || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= board.clock.now().getTime() || typeof reason !== 'string' || !reason.trim()) {
    throw new Refused('LAND_WAIVER', 'name a test, a future --until date and a nonempty --reason; run pullboard land --waive <test> --until <date> --reason "why"');
  }
  return atomic(board, () => {
    // This ordered result and event retain their released shape on every replay engine.
    // File/name classification belongs to a derived read, never immutable waiver history.
    const waiver = { id, test, until: new Date(until).toISOString(), reason: reason.trim(), by: PERSON, channel };
    logEvent(board, PERSON, 'landing_waiver', null, { waiver });
    return waiver;
  });
}

/** File one durable defect per flaky test and retain its source digest [B3,R3]. */
export function recordLandingFlake(board, { agentId, test, hash, names, lane, batchId }) {
  coordinatorOnly(agentId, 'files landing flakes');
  if (typeof test !== 'string' || !test || !/^[a-f0-9]{64}$/u.test(hash ?? '') || !Array.isArray(names) || !names.length || names.some((name) => typeof name !== 'string' || !name) || typeof batchId !== 'string') {
    throw new Refused('LAND_FLAKE', 'a flake needs its named test, exact source digest and failing names; inspect the landing log');
  }
  return atomic(board, () => {
    const existing = landingFlakes(board).find((entry) => entry.test === test);
    if (existing?.hash === hash) return existing;
    const item = existing?.item ?? addItem(board, { by: agentId, lane, title: `Flaky test: ${test}`,
      criterion: `${test} passes in a full gate and alone without retries; failures: ${names.join(', ')}`, route: 'strong' });
    const flake = { test, hash, names, item, batchId };
    logEvent(board, agentId, 'landing_flake', item, { flake });
    return flake;
  });
}

/** Atomically record a pushed batch's first-containing merges and one main-moved receipt [B3,R3]. */
export function finishLandingBatch(board, { agentId, id, tip, landingFence }) {
  coordinatorOnly(agentId, 'finishes a landing');
  landingEnvironment.requireTrunk(board);
  return atomic(board, () => {
    guardLandingWrite(board, landingFence);
    const batch = landingBatches(board).find((entry) => entry.id === id);
    if (!batch || batch.tip !== tip) throw new Refused('LAND_BATCH', 'the pushed tip must match its recorded batch; run pullboard land --adopt');
    landingEnvironment.requireStoredBatch(board, batch);
    if (batch.state === 'landed') return batch;
    if (batch.state !== 'pushed' && !(batch.state === 'trunk' && (board.executionEngineVersion ?? ENGINE_VERSION) >= LOCAL_LANDING_ENGINE)) throw new Refused('LAND_NOT_PUSHED', 'record a successful push before landing receipts; run pullboard land --adopt');
    for (const entry of batch.items) {
      const item = itemById(board, entry.id);
      if (item.item_commit !== entry.commit || item.item_status !== 'verified') {
        throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} changed after the batch was gated; rebuild its landing`);
      }
      if ((board.executionEngineVersion ?? ENGINE_VERSION) >= VERDICT_REVIEW_ENGINE
        && (entry.reviewedCommit ?? entry.commit) !== checkedLandingCommit(board, item)) {
        throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} was re-reviewed after the batch was gated; rebuild its landing`);
      }
      if (item.item_merged_commit && item.item_merged_commit !== entry.merge) {
        throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} already has another landing receipt; read pullboard show ${entry.id}`);
      }
      const accepted = acceptedVerdict(board, item);
      if ((board.executionEngineVersion ?? ENGINE_VERSION) < VERDICT_REVIEW_ENGINE
        && accepted?.review?.head && accepted.review.head !== (entry.reviewedCommit ?? entry.commit)) {
        // An old client may already have pushed B before a newer client checked C.
        // Record physical history without lending C's proof to B or wedging replay.
        logEvent(board, agentId, 'landing-review-moved', entry.id, {
          code: 'LAND_ITEM_MOVED', batch: id, verdict: accepted.verdict_id,
          checked: accepted.review.head, landed: entry.merge,
        });
      }
      if (!item.item_merged_commit) merged(board, entry.id, { agentId, commit: entry.merge });
    }
    logEvent(board, agentId, 'main-moved', null, { sha: tip, batch: id, items: batch.items.map((entry) => entry.id) });
    tellDeferredLandingReviews(board, batch);
    return recordLandingBatch(board, { agentId, batch: { ...batch, state: 'landed' }, revision: batch.revision, landingFence });
  });
}

/** Notify each deferred item's current audience once, in the landed transition's transaction. */
function tellDeferredLandingReviews(board, batch) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < LAND_COLLISION_ENGINE) return;
  for (const deferred of batch.blocked ?? []) {
    if (deferred.code !== 'LAND_FILE_OVERLAP') continue;
    const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(deferred.id);
    if (!item || item.item_status !== 'verified' || item.item_merged_commit) continue;
    const reviewer = item.item_review_by ?? item.item_verified_by ?? 'coordinator';
    persistShout(board, { from: 'landing', to: `item:${item.item_id}`,
      text: `#${item.item_id} waited for overlapping files while batch ${batch.id} landed at ${batch.tip}. ${reviewer}: merge current main into the reviewed commit and record a fresh merge-only re-accept before the next batch; no builder cycle or reopening is needed.`,
      detail: { item: item.item_id, batch: batch.id, files: deferred.files, reviewer } });
  }
}

/** File or refresh an outside source through the ordinary ordered engine. */
export function intakeOutside(board, options) { return applyOutsideIntake(board, options, { atomic, addItem, moveItem, validateItemAddition }); }

/** Apply a source move once, retaining its source MOVEID receipt [E15,H16]. */
export function applyRehomeItem(board, record, options) {
  return applyRehomeRecord(board, { record, ...options }, { atomic, boardId, logEvent, moveItem, validateItemAddition, now });
}

/** Record the person's exact-commit owner approval. */
export function approveOutside(board, id, options) { return applyOutsideApproval(board, id, options, atomic); }

/** Name a lane lead only through coordinator-owned ordered policy [B21]. */
export function setLaneLead(board, options) {
  return applyLaneLead(board, options, { atomic, logEvent });
}
/** Tailored inbox activity is the same canonical read projection as other board queries. */
export { agentActivity } from './board-query.js';

export { recordRowVerification, rowVerifications } from './spec-verdicts.js';
/** Read recipient delivery state without mutating any cursor or receipt. */
export function activityDeliveryState(board, agentId) {
  return activityDeliveryStore.activityDeliveryState(board, agentId);
}

/** Record the exact interrupts included in an authenticated recipient response. */
export function recordActivityDelivery(board, options) {
  return activityDeliveryStore.recordActivityDelivery(board, options, { atomic, logEvent });
}

/** Record an explicit recipient acknowledgement separately from delivery. */
export function actOnActivity(board, options) {
  return activityDeliveryStore.actOnActivity(board, options, { atomic, logEvent });
}
import { FLOW_SIZE_ENGINE } from './flow-size-engine.js';
import { submissionSize } from './submission-size.js';
