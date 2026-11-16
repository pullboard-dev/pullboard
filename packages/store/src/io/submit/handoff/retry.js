import { movesLiveEnabled } from "../../../../../config/index.js";
import { shadowed } from "./shadow.js";
import { startDecision } from "./shadow.js";
import { liveStartDecision } from "./shadow.js";
import { liveSetting } from "../../board/submit.js";
import { shadowHook } from "../../board/shadow-record.js";
import { shadowDecide } from "../../board/shadow-record.js";
import { firstDifference } from "../../board/shadow-record.js";
import { shadowSetting } from "../../board/submit.js";
import { queueDiffers } from "./shadow.js";
import { queueDecision } from "./shadow.js";
import { ownershipWaitForJob } from '../../board/wait.js';
import { INFRA_HANDOFF_RECOVERY_ENGINE } from '../../../../../state/light.js';
import { DEAD_HANDOFF_RETRY_ENGINE } from '../../../../../state/index.js';
import { RUNNING_HANDOFF_ITEM_CHECK_ENGINE } from '../../../../../state/index.js';
import {
  boardWriteSnapshot,
  requireBoardWriteSnapshot,
} from "../../board/write/preparation.js";
import { insertShout } from "../../board/shout.js";
import {
  submitHandoff,
  pendingSubmitHandoff,
} from "./records.js";
export { submitHandoff, pendingSubmitHandoff, awaitingGateOrReview, submitHandoffFailure } from "./records.js";
/** Durable queue observations do not grant submission or review authority [C7,V4,H16]. */
import {
  atomic,
  logEvent,
} from "../../board/event/log.js";
import { release } from "../../board.js";
import { setItem } from "../../board.js";
import {
  getItem,
  now,
  proofReceipts,
} from "../../board/query.js";
import { Refused } from "../../../../../kernel/index.js";
import { TRANSIENT_CODES } from "../../../../../kernel/index.js";
import { runSubmitTable } from "../../../logic/board/landing/lease.js";

/** Requeues of the same candidate after a spent gate infrastructure retry budget. */
const EXHAUSTED_RETRIES = 2;
/**
 * Automatic requeues of one candidate whose gate worker died or whose gate infrastructure was spent, before the stop is
 * final and the sentinel shouts once. Why three: a stall that kills workers can kill the first
 * retries too, and none of those gates had a fault in its candidate (#3714).
 */
export const INFRASTRUCTURE_RETRY_LIMIT = 3;
/**
 * Runner refusals that mean the host could not run the work right now: the gate requeues on another runner and a sharded
 * landing reruns the shard. One list serves both, so the two cannot drift apart again (#3753).
 */
export const RERUNNABLE_RUNNER_REFUSALS = Object.freeze(['RUNNER_SETUP_REFUSED', 'RESOURCE_LEASE_LOST', 'RUNNER_BROWSER_SLOT_REQUIRED', 'RUNNER_GUI_SESSION_REQUIRED']);

/**
 * Error codes that stop a queued gate for infrastructure reasons, not the builder's source: a Git read that kept
 * failing (#2521), a gate whose bounded infrastructure retries were spent (#2516), and every machinery code the
 * queued worker reruns on. One set serves both sides, so a code the worker treats as infrastructure never reaches
 * the builder as a red (#3074).
 */
export const INFRASTRUCTURE_CODES = Object.freeze(new Set([
  'GIT_READ_INFRASTRUCTURE', 'GATE_INFRA_EXHAUSTED',
  'RUNNER_UNAVAILABLE', 'RUNNER_JOB_LOST', 'RUNNER_CLEANUP_TIMEOUT', 'RUNNER_WAIT_DEADLINE', 'RUNNER_INFRA_RETRY_EXHAUSTED',
  'RUNNER_BUSY', ...RERUNNABLE_RUNNER_REFUSALS, 'TRANSPORT_LOST', 'CLEANUP_TIMEOUT', ...TRANSIENT_CODES,
  'MERGE_CHECK_FAILED',
  // The remote analysis step returned nothing, or the resource lease vanished under the gate: machinery, not source (#3303).
  'RUNNER_RESULT_INVALID',
  // Accepted policy changed or became unavailable; the captured source has no test failure.
  'NO_POLICY',
  // The board's Git sync lease stayed busy or origin did not answer: the machine, not the source (#3111).
  'GIT_SYNC_LOCK_BUSY', 'GIT_SYNC_REMOTE',
  // A runner refused the request's size or history scan: the gate requeues on a runner, never runs locally (#3898).
  'RUNNER_REQUEST_LIMIT', 'RUNNER_SCAN_LIMIT',
]));

/**
 * Whether a hand-off still serves its item: it is the item's current hand-off, queued or running, and the item is
 * claimed by the hand-off's seat at its frozen digest. Why: a gate driver, its dispatcher and the fallback all ask
 * this one question, so a withdrawn, reopened or replaced item's gate ends wherever it is noticed (#4072, SM1).
 *
 * @param {any} board - An open board.
 * @param {number} itemId
 * @param {string} handoffId - The hand-off job id the gate runs for.
 * @returns {boolean}
 */
export function handoffServes(board, itemId, handoffId) {
  const handoff = submitHandoff(board, itemId);
  if (!handoff || handoff.id !== handoffId || !['queued', 'running'].includes(handoff.state)) return false;
  const item = board.db.prepare('SELECT item_status, item_owner, item_frozen_digest FROM item WHERE item_id = ?').get(itemId);
  return item?.item_status === 'claimed' && item.item_owner === handoff.agentId && item.item_frozen_digest === handoff.digest;
}

/**
 * Whether a running gate's own driver should keep going: its hand-off still serves its item, or the gate has just
 * submitted the item at the head that hand-off submitted and only the stored result remains.
 * Why: the gate's own submit move marks the item submitted while the hand-off still reads running, until
 * completeSubmitHandoff stores the result, so a driver that asked only handoffServes would end its finished gate
 * stale and never record it. The same holds for a gate that went green on paths another lane owns: its submit move
 * releases the claim into an ownership wait for this source, so that wait also keeps the driver recording (#5524).
 * Only a driver already running its gate asks this; admitting or resuming a driver still
 * needs handoffServes, since startSubmitHandoff refuses a running hand-off whose item is no longer claimed (#4073).
 *
 * @param {any} board - An open board.
 * @param {number} itemId
 * @param {string} handoffId - The hand-off job id the gate runs for.
 * @returns {boolean}
 */
export function handoffGateCurrent(board, itemId, handoffId) {
  if (handoffServes(board, itemId, handoffId)) return true;
  const handoff = submitHandoff(board, itemId);
  if (!handoff || handoff.id !== handoffId || !['queued', 'running'].includes(handoff.state) || !handoff.commit) return false;
  const item = board.db.prepare('SELECT item_status, item_built_by, item_frozen_digest, item_commit FROM item WHERE item_id = ?').get(itemId);
  if (item?.item_status === 'submitted' && item.item_built_by === handoff.agentId
    && item.item_frozen_digest === handoff.digest && item.item_commit === handoff.commit) return true;
  // A gate that went green on foreign paths released the claim into an owner wait for this very source; only its result remains.
  const wait = ownershipWaitForJob(board, handoffId);
  return Boolean(wait && wait.agentId === handoff.agentId && wait.commit === handoff.commit && wait.digest === handoff.digest);
}

/**
 * Whether a queued gate's refusal is the machine's, not the builder's source: an infrastructure code, or a worker that
 * exited on a signal before it recorded a result (SUBMIT_HANDOFF_EXIT naming a signal). Why: on 4 Nov 17 of 52 queued
 * reds were machine refusals charged to their builders, 3 of them workers stopped by SIGTERM (#3111).
 *
 * @param {{ code: string, message?: string, signal?: string }} error - The canonical refusal document's error.
 */
export function infrastructureStop(error) {
  if (INFRASTRUCTURE_CODES.has(error.code)) return true;
  return error.code === 'SUBMIT_HANDOFF_EXIT' && (typeof error.signal === 'string' && error.signal !== ''
    || /\bSIG[A-Z0-9]+\b/u.test(String(error.message ?? '')));
}
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { QUEUED_RED_RETURN_ENGINE } from "../../../../../state/light.js";
import { PIPELINE_CAUSE_ENGINE } from "../../../../../state/light.js";
import { pipelineCause } from "../../../../../kernel/index.js";
import { CONVEYOR_RETURN_ENGINE } from "../../../../../state/light.js";

const PREPARED = new WeakMap();
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const JOB = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

/**
 * Save a hand-off onto its gate job through the jobs cell's `shadowJob` port, within the caller's short native
 * transaction: the queue creates the gate job and every state change is a step of it. No filesystem or process work
 * runs here.
 * Why: the job row is the one place the hand-off record lives (#3476), so a board opened without the jobs cell's
 * port cannot record a hand-off at all, rather than keep a copy no reader sees [C7].
 */
function save(board, id, job) {
  const write = board.enginePorts?.shadowJob;
  if (typeof write !== 'function') throw new Refused('NO_POLICY', 'Supply the jobs cell port shadowJob before recording a submit hand-off.');
  write(board.db, id, job, { now: Date.parse(now(board)) });
}

/** Keep private job identifiers and refusal text out of the public native event payload. */
function record(board, id, job) {
  logEvent(board, job.agentId, 'submit-handoff', id, { state: job.state, commit: job.commit });
  save(board, id, job);
  return structuredClone(job);
}

/** Validate a captured candidate without treating a queue request as a gate receipt. */
function candidate(value) {
  if (!Number.isSafeInteger(value.leaseMs) || value.leaseMs <= 0 || !JOB.test(value.job ?? '') || !SHA.test(value.main ?? '') || !SHA.test(value.commit ?? '') || !SHA.test(value.tree ?? '') || !SHA.test(value.executionCommit ?? '') || !SHA.test(value.executionTree ?? '') || !DIGEST.test(value.digest ?? '') || !(value.companionDigest === null || DIGEST.test(value.companionDigest ?? ''))) {
    throw new Refused('BAD_SUBMIT_HANDOFF', 'queue a clean committed candidate with its exact frozen bar');
  }
}

/** Capture source outside the writer and bind the prepared values to one native connection and snapshot. */
export function prepareQueueSubmitHandoff(board, id, options) {
  candidate(options);
  const previous = PREPARED.get(options);
  if (previous?.board === board && previous.id === id) return options;
  const snapshot = boardWriteSnapshot(board);
  board.enginePorts.sealSubmitHandoffQueue(board, id, options);
  requireBoardWriteSnapshot(board, snapshot, 'queueSubmitHandoff');
  const prepared = Object.freeze({ ...options });
  PREPARED.set(prepared, { board, id, snapshot });
  return prepared;
}

/**
 * Record one candidate for the existing live holder; repeated sends never schedule another gate.
 * A board that carries `queueSubmitHandoffShadow` is handed the SUBMIT table's answer beside what this returned or refused with, for the store test to compare [C7,#8280].
 */
export function queueSubmitHandoff(board, id, options) {
  // With moves.live.submit on (a board's own `movesLive.submit` stands in for the setting in a store test), the SUBMIT table decides: it refuses before any write
  // opens and the record it names is the one kept. The setting is read here, before the board write, so no file I/O runs inside it [C7,#8384].
  if ((board.movesLive?.submit ?? movesLiveEnabled('submit')) === true) {
    candidate(options);
    const decided = queueDecision(board, id, options, { retryLimit: INFRASTRUCTURE_RETRY_LIMIT, infrastructureCodes: INFRASTRUCTURE_CODES }, true);
    if (decided.refused) throw new Refused(decided.refused.code, decided.refused.message, decided.refused.next);
    return writeQueueHandoff(board, id, options, decided);
  }
  return shadowed(board, 'queueSubmitHandoffShadow', id, true, () => queueDecision(board, id, options, { retryLimit: INFRASTRUCTURE_RETRY_LIMIT, infrastructureCodes: INFRASTRUCTURE_CODES }), () => writeQueueHandoff(board, id, options), { table: 'submit', differs: queueDiffers });
}

/** The writer's own checks and the record it keeps. */
function writeQueueHandoff(board, id, options, decided = null) {
  candidate(options);
  const prepared = board.executionEngineVersion === undefined ? prepareQueueSubmitHandoff(board, id, options) : options;
  const snapshot = PREPARED.get(prepared)?.snapshot;
  options = prepared;
  return atomic(board, () => {
    if (snapshot) requireBoardWriteSnapshot(board, snapshot, 'queueSubmitHandoff');
    const item = getItem(board, id);
    const until = Date.parse(item.item_lease_until);
    if (!decided && (item.item_status !== 'claimed' || item.item_owner !== options.agentId
      || !Number.isFinite(until) || until <= Date.parse(now(board)))) {
      throw new Refused('NOT_YOURS', 'claim this item before submitting it');
    }
    if (item.item_frozen_digest !== options.digest || board.enginePorts.itemPatchDigest(board, id, options.commit) !== options.companionDigest) throw new Refused('SUBMIT_HANDOFF_CHANGED', 'read and claim the current frozen bar before queuing a gate');
    const pending = pendingSubmitHandoff(board, item);
    if (pending) {
      if (pending.commit !== options.commit || pending.tree !== options.tree || pending.digest !== options.digest || pending.companionDigest !== options.companionDigest) {
        throw new Refused('SUBMIT_HANDOFF_PENDING', 'the original queued candidate is still running; leave it unchanged and take other work with pullboard next');
      }
      return { job: pending, created: false };
    }
    const job = decided?.job ?? { version: 1, id: options.job, agentId: options.agentId, commit: options.commit,
      tree: options.tree, main: options.main, executionCommit: options.executionCommit, executionTree: options.executionTree, digest: options.digest, companionDigest: options.companionDigest, leaseMs: options.leaseMs, state: 'queued', at: now(board) };
    return { job: record(board, id, job), created: true };
  });
}

/** Bind every worker transition to its original native queue record and actor. */
function matching(board, id, { agentId, job }) {
  const saved = submitHandoff(board, id);
  if (!saved || saved.id !== job || saved.agentId !== agentId) {
    throw new Refused('SUBMIT_HANDOFF_CHANGED', 'read the current queued submission; an old or foreign worker cannot complete it');
  }
  return saved;
}

/** Require genuine clean green native receipts for this exact immutable job, never a claimed receipt body. */
export function requireSubmitHandoffHookProof(board, id, job, projection) {
  const item = getItem(board, id);
  const ids = projection?.receipts;
  const receipts = proofReceipts(board, id);
  if (projection?.job !== job.id || projection.commit !== job.executionCommit || projection.tree !== job.executionTree
    || projection.digest !== job.digest || job.state !== 'running' || item.item_status !== 'claimed'
    || item.item_owner !== job.agentId || item.item_frozen_digest !== job.digest
    || !(item.item_lease_until > now(board)) || board.enginePorts.itemPatchDigest(board, id, job.commit) !== job.companionDigest
    || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
    || ids.some(id => !receipts.some(receipt => receipt.id === id && receipt.kind === 'submit'
      && receipt.item === item.item_id && receipt.seat === job.agentId && receipt.commit === job.executionCommit
      && receipt.tree === job.executionTree && receipt.frozenDigest === job.digest && receipt.sourceClean === true
      && receipt.exitCode === 0 && receipt.counts?.failed === 0))) {
    throw new Refused('SUBMIT_HANDOFF_AUTHORITY', 'the merge hook needs this exact native job, source, frozen bar and successful proof receipts');
  }
  return projection;
}

/**
 * End an item's queued or running hand-off because the item is withdrawn, in the withdrawal's own board write.
 * Why: a record leaves queued only when a worker writes a result, so a withdrawn item's hand-off stayed queued and could
 * still be started (#2800 and #3291 on 6 Nov); an ended record makes startSubmitHandoff start nothing [C7].
 *
 * @param {object} board
 * @param {number} id
 * @returns {Record<string, any> | null} The ended record, or null when the item had no queued or running hand-off.
 */
export function endWithdrawnHandoff(board, id) {
  if (typeof board.enginePorts?.submitHandoffEngines !== 'function' || typeof board.enginePorts?.shadowJob !== 'function') return null;
  const job = submitHandoff(board, id);
  if (!job || !['queued', 'running'].includes(job.state)) return null;
  return record(board, id, { ...job, state: 'ended', reason: 'withdrawn', completedAt: now(board) });
}

/**
 * Record an item's queued or running gate as withdrawn, at the request of the seat that holds the item or the coordinator.
 * Why: a gate that sat in the line for hours had no command to stop it (#2828); the record ends at once, a later result
 * from its worker is ignored because completeSubmitHandoff stores nothing on a finished record, and a fresh submit
 * queues a new gate because only a queued or running record counts as pending [C7].
 *
 * @param {object} board
 * @param {number} id
 * @param {{ agentId: string }} who - The seat asking, bound to the move's sender.
 * @returns {Record<string, any>} The withdrawn record.
 */
function withdrawGate(board, id, { agentId }) {
  const job = submitHandoff(board, id);
  if (!job || !['queued', 'running'].includes(job.state)) {
    throw new Refused('GATE_NOT_WAITING', `item #${id} has no queued or running gate to withdraw; pullboard show ${id} prints its gate state`);
  }
  if (agentId !== job.agentId && agentId !== 'coordinator') {
    throw new Refused('NOT_YOURS', `only the seat that submitted #${id} or the coordinator can withdraw its gate; ask ${job.agentId} or the coordinator`);
  }
  return record(board, id, { ...job, state: 'withdrawn', reason: 'gate withdrawn', withdrawnBy: agentId, completedAt: now(board) });
}

/**
 * Exactly one detached worker enters the existing canonical submit path.
 * A board that carries `startSubmitHandoffShadow` is handed the START table's answer beside what this returned or refused with, for the store test to compare [C7,#8279].
 */
export function startSubmitHandoff(board, id, options) {
  const hookProblem = () => { try { requireSubmitHandoffHookProof(board, id, submitHandoff(board, id), options.hookProjection); return null; } catch (error) { return { code: error.code, message: error.message, next: error.next }; } };
  const modelled = (board.executionEngineVersion ?? ENGINE_VERSION) >= RUNNING_HANDOFF_ITEM_CHECK_ENGINE;
  // With moves.live.handoff on (a board's own `movesLive.handoff` stands in for the setting in a store test), the START table decides: it refuses before any
  // write opens and the record and events it names are the ones written. The setting is read here, before the board write, so no file I/O runs inside it [C7,#8385].
  if (modelled && liveHandoff(board)) return liveStartHandoff(board, id, options, hookProblem);
  return shadowed(board, 'startSubmitHandoffShadow', id, modelled,
    () => startDecision(board, id, options, { retryLimit: INFRASTRUCTURE_RETRY_LIMIT, infrastructureCodes: INFRASTRUCTURE_CODES }, hookProblem), () => writeStartHandoff(board, id, options), { table: 'start', differs: startDiffers });
}

/** Whether moves.live.handoff is on for this board: its own `movesLive.handoff` (a store test), else the machine setting. A file read, so call it before a board write opens. */
function liveHandoff(board) {
  return (board.movesLive?.handoff ?? liveSetting('handoff')) === true;
}

/** What a move's refusal and the state it must still find on the board: the saved hand-off and the item's claim, as one string to compare. */
function basis(board, id) {
  const item = board.db.prepare('SELECT item_status, item_owner, item_lease_until, item_frozen_digest FROM item WHERE item_id = ?').get(id);
  return JSON.stringify([submitHandoff(board, id), item ? { ...item } : null]);
}

/**
 * Write what a hand-off table decided: its events in order, a shout as a shout and the hand-off record as the saved record, which logs its own event.
 * `release` is the one event whose item move the writer's release does, so it is called, not logged twice.
 */
function writeHandoffEvents(board, id, decided) {
  for (const event of decided.events) {
    if (event.kind === 'shout') insertShout(board, { from: event.by, to: event.detail.to, text: event.detail.text, lanes: [] });
    else if (event.kind === 'submit-handoff') record(board, id, decided.record ?? decided.job);
    else if (event.kind === 'release') release(board, id, event.by, event.detail.reason, undefined, event.detail.reasonCode);
    else logEvent(board, event.by, event.kind, id, event.detail);
  }
}

/** The live start: the START table decides before the write opens, then its record and events are written; a hand-off that moved in between is refused. */
function liveStartHandoff(board, id, options, hookProblem) {
  const was = basis(board, id);
  const decided = liveStartDecision(board, id, options, { retryLimit: INFRASTRUCTURE_RETRY_LIMIT, infrastructureCodes: INFRASTRUCTURE_CODES }, hookProblem);
  if (decided.refused) throw new Refused(decided.refused.code, decided.refused.message, decided.refused.next);
  return atomic(board, () => {
    if (basis(board, id) !== was) throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the hand-off changed while this move was decided', `read pullboard show ${id} for the current queued submission and try again`);
    writeHandoffEvents(board, id, decided);
    return { started: decided.via === 'start', job: decided.events.length ? structuredClone(decided.job) : decided.job };
  });
}

/** Where the START table's answer and the start writer's part: the refusals, whether a gate started, or else the kept hand-off record. */
export function startDiffers({ decided, wrote }) {
  if (decided?.threw) return `threw ${decided.threw}`;
  if (decided?.refused || wrote.refused) return firstDifference(decided?.refused ?? null, wrote.refused ?? null, 'refused') ?? 'refused';
  if ((decided.via === 'start') !== (wrote.returned.started === true)) return 'started';
  return firstDifference(decided.job ?? null, JSON.parse(JSON.stringify(wrote.returned.job ?? null)), 'job');
}

/** The writer's own checks and the record it keeps. */
function writeStartHandoff(board, id, options) {
  return atomic(board, () => {
    const job = matching(board, id, options);
    if (options.hookProjection) {
      const projection = requireSubmitHandoffHookProof(board, id, job, options.hookProjection);
      return { started: false, job: record(board, id, { ...job, hookProjection: { ...projection, at: now(board) } }) };
    }
    if (options.unrecoverable) return { started: false, job: spendStoppedHandoff(board, id, job, options.unrecoverable) };
    if (options.retryJob) return { started: false, job: retryStoppedHandoff(board, id, job, options.retryJob) };
    const item = getItem(board, id);
    const serving = item.item_status === 'claimed' && item.item_owner === options.agentId && item.item_frozen_digest === job.digest;
    // A running hand-off is resumed by the driver admitted after a dead one; it resumes only while its item still
    // waits on it, as a queued one starts only then (#4073, state-machine gap SM3).
    if (job.state === 'running' && (board.executionEngineVersion ?? ENGINE_VERSION) >= RUNNING_HANDOFF_ITEM_CHECK_ENGINE && !serving) {
      throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the running claim or frozen bar changed; do not resume its old gate');
    }
    if (job.state !== 'queued') return { started: false, job };
    if (!serving) {
      throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the queued claim or frozen bar changed; do not run its old gate');
    }
    return { started: true, job: record(board, id, { ...job, state: 'running', startedAt: now(board) }) };
  });
}

/**
 * What the COMPLETE table says storing this result does over the board as it stands: the path it takes, the hand-off record it saves and the events it writes, or its refusal.
 * Why: the writer's own checks and the table must give one answer, and the shadow compare shows it [C7,#8282].
 *
 * @returns {{ refused?: object, via?: string, record?: object, events?: object[] }}
 */
export function completionDecision(board, id, { result, agentId, job: jobId, returnToBoard: toBoard }) {
  const saved = submitHandoff(board, id);
  const changed = 'read the current queued submission; an old or foreign worker cannot complete it';
  if (!saved || saved.id !== jobId || saved.agentId !== agentId) return { refused: { code: 'SUBMIT_HANDOFF_CHANGED', message: changed, next: changed } };
  const item = getItem(board, id);
  const wait = ownershipWaitForJob(board, saved.id);
  // The writer's own check of an ownership wait's receipt, handed to the table as the refusal it passes through (a finished hand-off is stored as it is, so it asks nothing).
  const waitProblem = ['queued', 'running'].includes(saved.state) && (wait || result?.code === 0 && result.ownershipWait)
    && (!wait || wait.agentId !== saved.agentId || wait.commit !== saved.executionCommit || result?.ownershipWait && wait.key !== result.ownershipWait
      || wait.tree !== saved.executionTree || wait.digest !== saved.digest || wait.main !== saved.main)
    ? { code: 'SUBMIT_HANDOFF_RESULT', message: 'the queued source needs its own immutable ownership-wait receipt', next: 'wait for the ownership receipt of this exact source, then complete the queued gate' } : null;
  const events = board.db.prepare("SELECT event_by AS by, event_detail AS detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id").all(id).map(row => ({ by: row.by, detail: JSON.parse(row.detail) }));
  const snapshot = { now: now(board), actor: { id: agentId, joined: true },
    item: { id, status: item.item_status, owner: item.item_owner, leaseUntil: item.item_lease_until, frozenDigest: item.item_frozen_digest, builtBy: item.item_built_by, commit: item.item_commit },
    children: [], rejects: [], history: [], submits: events, receipts: proofReceipts(board, id), handoff: saved, io: {}, deferred: { ownershipWait: wait ? { key: wait.key } : null, ownershipWaitProblem: waitProblem } };
  const move = { id, actor: agentId, job: jobId, result, ...(toBoard === true ? { returnToBoard: true } : {}), ...(result?.windowSpent === true ? { windowSpent: true } : {}) };
  const answer = runSubmitTable('COMPLETE', { retryLimit: INFRASTRUCTURE_RETRY_LIMIT, infrastructureCodes: INFRASTRUCTURE_CODES }, snapshot, move);
  if (answer.refused) {
    const injected = answer.refused.code.startsWith('deferred:') ? snapshot.deferred[answer.refused.code.slice('deferred:'.length)] : null;
    return { refused: injected ? { code: injected.code, message: injected.message, next: injected.next } : { code: answer.refused.code, message: answer.refused.message, next: answer.refused.next } };
  }
  const outcome = answer.table.outcomes.find(o => o.id === answer.via[0]);
  return { via: answer.via[0], events: answer.events, patch: answer.patch, record: outcome.record?.(snapshot, move) };
}

/** The events a write left on the thread since `after`, in the shape the table writes them: shouts by recipient and text, the rest by kind, writer and detail. */
function eventsSince(board, after) {
  const shouts = new Map(board.db.prepare('SELECT shout_id, shout_text FROM shout').all().map(row => [row.shout_id, row.shout_text]));
  return board.db.prepare('SELECT event_by AS by, event_kind AS kind, event_detail AS detail FROM event WHERE event_id > ? ORDER BY event_id').all(after).map(row => {
    const { model, ...detail } = JSON.parse(row.detail);
    return row.kind === 'shout' ? { kind: 'shout', by: row.by, item: null, detail: { to: detail.to, text: detail.text ?? shouts.get(detail.shout) } } : { kind: row.kind, by: row.by, detail };
  });
}

/**
 * Store the canonical result without performing any submission transition or accepting new proof.
 * A board that carries `submitCompleteShadow` is handed the table's answer beside what this saved and wrote, for the store test to compare [C7,#8282].
 */
export function completeSubmitHandoff(board, id, options) {
  const { result, withdrawn } = options;
  const modeled = (board.executionEngineVersion ?? ENGINE_VERSION) >= Math.max(QUEUED_RED_RETURN_ENGINE, PIPELINE_CAUSE_ENGINE, CONVEYOR_RETURN_ENGINE, INFRA_HANDOFF_RECOVERY_ENGINE, DEAD_HANDOFF_RETRY_ENGINE);
  // With moves.live.handoff on, the COMPLETE table decides before the write opens, and the record and events it names are the ones written [C7,#8385].
  if (withdrawn !== true && result != null && modeled && liveHandoff(board)) return liveCompleteHandoff(board, id, options);
  const hook = withdrawn === true || result == null || !modeled ? null : shadowHook(board, 'submitCompleteShadow', 'complete', completeDiffers, shadowSetting);
  if (!hook) return writeCompletion(board, id, options);
  const decided = shadowDecide(hook, () => completionDecision(board, id, options));
  const after = board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
  let wrote;
  try { wrote = { record: writeCompletion(board, id, options), events: eventsSince(board, after) }; } catch (error) { wrote = { refused: { code: error.code, message: error.message } }; }
  hook({ id, decided, wrote });
  if (wrote.refused) throw new Refused(wrote.refused.code, wrote.refused.message);
  return wrote.record;
}

/** The live completion: the COMPLETE table refuses before the write opens, or its lease patch, events and hand-off record are written; a hand-off that moved in between is refused. */
function liveCompleteHandoff(board, id, options) {
  const was = basis(board, id);
  const decided = completionDecision(board, id, options);
  if (decided.refused) throw new Refused(decided.refused.code, decided.refused.message, decided.refused.next);
  return atomic(board, () => {
    if (basis(board, id) !== was) throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the hand-off changed while this move was decided', `read pullboard show ${id} for the current queued submission and try again`);
    if (decided.patch?.leaseUntil) setItem(board, id, { item_lease_until: decided.patch.leaseUntil });
    writeHandoffEvents(board, id, decided);
    return decided.record ? structuredClone(decided.record) : submitHandoff(board, id);
  });
}

/** Where the COMPLETE table's answer and the completion writer's part: the refusals' codes, then the saved record, then the events written. */
export function completeDiffers({ decided, wrote }) {
  if (decided?.threw) return `threw ${decided.threw}`;
  if (decided?.refused || wrote.refused) return firstDifference(decided?.refused?.code ?? null, wrote.refused?.code ?? null, 'refused') ?? 'refused';
  const json = value => JSON.parse(JSON.stringify(value ?? null));
  return firstDifference(json(decided.record), json(wrote.record), 'record') ?? firstDifference(json(decided.events), json(wrote.events), 'events');
}

/** The writer's own checks, the hand-off record it saves and the events it writes. */
function writeCompletion(board, id, { result, reopenFirstRefusalMinutes, ...options }) {
  return atomic(board, () => {
    if (options.withdrawn === true) return withdrawGate(board, id, options);
    const saved = matching(board, id, options);
    if (!['queued', 'running'].includes(saved.state)) return saved;
    const job = { ...saved, ...lockWaitRecord(result?.lockWaits) };
    const item = getItem(board, id);
    const ownerWait = ownershipWaitForJob(board, job.id);
    if (ownerWait || result?.code === 0 && result.ownershipWait) {
      const wait = ownerWait;
      if (!wait || wait.agentId !== job.agentId || wait.commit !== job.executionCommit || result?.ownershipWait && wait.key !== result.ownershipWait
        || wait.tree !== job.executionTree || wait.digest !== job.digest || wait.main !== job.main) {
        throw new Refused('SUBMIT_HANDOFF_RESULT', 'the queued source needs its own immutable ownership-wait receipt');
      }
      return record(board, id, { ...job, state: 'ownership-wait', gateGreen: false,
        ownershipWait: wait.key, completedAt: now(board) });
    }
    if (result?.code === 0) {
      if (item.item_status !== 'submitted' || item.item_built_by !== job.agentId || item.item_commit !== result.commit) {
        throw new Refused('SUBMIT_HANDOFF_RESULT', 'a queue result cannot replace the normal proved submit transition');
      }
      const latest = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit' AND event_by=? ORDER BY event_id DESC LIMIT 1").get(id, job.agentId);
      const submitted = latest ? JSON.parse(latest.event_detail) : null;
      const proved = proofReceipts(board, id).some(receipt => receipt.kind === 'submit' && receipt.commit === job.executionCommit
        && receipt.tree === job.executionTree && receipt.seat === job.agentId && receipt.frozenDigest === job.digest && receipt.sourceClean === true);
      if (!submitted || submitted.commit !== result.commit || submitted.criterionDigest !== job.digest || submitted.policyCommit !== job.main || !proved) {
        throw new Refused('SUBMIT_HANDOFF_RESULT', 'the queued source needs its own actual native submit event and captured-source proof receipts');
      }
      const gateGreen = submitted.gateGreen === true;
      return record(board, id, { ...job, state: gateGreen ? 'green' : 'submitted', gateGreen, submitted: result.commit, completedAt: now(board) });
    }
    if (result?.code !== 1 || !result.error || typeof result.error.code !== 'string' || !result.error.code
      || typeof result.error.message !== 'string' || typeof result.error.next !== 'string') {
      throw new Refused('BAD_SUBMIT_HANDOFF', 'retain the exact canonical refusal document before completing this queued gate');
    }
    if (result.error.code === 'SUBMIT_HANDOFF_DEAD' && (board.executionEngineVersion ?? ENGINE_VERSION) >= DEAD_HANDOFF_RETRY_ENGINE) {
      if ((board.executionEngineVersion ?? ENGINE_VERSION) < INFRA_HANDOFF_RECOVERY_ENGINE) return endDeadHandoff(board, id, item, job, result.error, options.retryJob);
      return recordInfrastructureStop(board, id, job, result.error);
    }
    if (result.error.code === 'GATE_INFRA_EXHAUSTED' && (board.executionEngineVersion ?? ENGINE_VERSION) < INFRA_HANDOFF_RECOVERY_ENGINE
      && options.retryJob !== undefined && (job.recoveryRetries ?? 0) < EXHAUSTED_RETRIES) {
      // Spent runner retries requeue the same candidate once more, up to twice, with no shout until they are used up (#3074).
      return endDeadHandoff(board, id, item, job, result.error, options.retryJob, EXHAUSTED_RETRIES);
    }
    if (infrastructureStop(result.error) && item.item_status !== 'submitted') {
      // A Git read that kept failing, or runners that kept failing, is the machine's fault: the item stays claimed and the builder gets no red (#2521, #2516).
      if ((board.executionEngineVersion ?? ENGINE_VERSION) >= INFRA_HANDOFF_RECOVERY_ENGINE) return recordInfrastructureStop(board, id, job, result.error, result.windowSpent === true);
      insertShout(board, { from: 'sentinel', to: 'coordinator', text: `Queued gate for #${id} stopped on infrastructure (${result.error.code}); nothing is wrong with the builder's source. Resubmit it once ${result.error.code === 'GIT_READ_INFRASTRUCTURE' ? 'the Git read recovers' : 'a runner is healthy'}.`, lanes: [] });
      return record(board, id, { ...job, state: 'infrastructure', error: { ...result.error }, completedAt: now(board) });
    }
    const state = item.item_status === 'submitted' ? 'incomplete' : 'red';
    const keeps = (board.executionEngineVersion ?? ENGINE_VERSION) >= QUEUED_RED_RETURN_ENGINE;
    const toBoard = options.returnToBoard === true && (board.executionEngineVersion ?? ENGINE_VERSION) >= CONVEYOR_RETURN_ENGINE;
    if (state === 'red' && toBoard && item.item_status === 'claimed' && item.item_owner === job.agentId && item.item_frozen_digest === job.digest) {
      returnToBoard(board, id, job, result.error);
    } else if (state === 'red' && keeps && item.item_status === 'claimed' && item.item_owner === job.agentId && item.item_frozen_digest === job.digest) {
      returnToBuilder(board, id, job, result.error);
    } else if (state === 'red' && item.item_status === 'claimed' && item.item_owner === job.agentId && item.item_frozen_digest === job.digest) {
      const reservation = reopenFirstRefusalMinutes > 0
        ? board.enginePorts.firstRefusalDetail(board, { ...item, item_built_by: job.agentId }, reopenFirstRefusalMinutes)
        : { reopenFirstRefusal: { builder: job.agentId, until: new Date(board.clock.now().getTime() + job.leaseMs).toISOString() } };
      release(board, id, job.agentId, 'the queued canonical submit was refused', undefined, 'OTHER');
      logEvent(board, job.agentId, 'submit_handoff_returned', id, { commit: job.commit, ...reservation });
      insertShout(board, { from: 'coordinator', to: job.agentId, text: `Queued submit #${id} was refused (${result.error.code}); read pullboard show ${id} for the original refusal; finish or release your current build at a natural break, then claim this item.`, lanes: [] });
    }
    return record(board, id, { ...job, state, error: { ...result.error }, completedAt: now(board) });
  });
}

/**
 * The lock waits a queued gate sat through, as a job field: count, total wait in ms and count per lock code.
 * Why: a gate that waits on a busy board instead of stopping (#3087) should still show the wait it paid.
 */
function lockWaitRecord(waits) {
  const count = Number(waits?.count), totalMs = Number(waits?.totalMs);
  if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(totalMs) || totalMs < 0) return {};
  const codes = Object.fromEntries(Object.entries(waits.codes ?? {})
    .filter(([code, n]) => /^[A-Z_]{1,40}$/u.test(code) && Number.isSafeInteger(n) && n > 0));
  return { lockWaits: { count, totalMs, codes } };
}

/**
 * Keep a red queued item claimed by the seat that submitted it, with a fresh lease from now.
 * Why: a released red sat open with no holder while the cause was unread (#2454); the builder fixes it first,
 * and only a lease that lapses without action frees the item for anyone.
 */
function returnToBuilder(board, id, job, error) {
  const leaseUntil = new Date(board.clock.now().getTime() + job.leaseMs).toISOString();
  setItem(board, id, { item_lease_until: leaseUntil });
  // The fresh deadline is lease evidence like any renewal, so lapsed-claim maintenance can free it once it ends.
  // From the typed-cause engine the same renew event names why the gate came back red: the refusal code and its cause (#3071).
  const text = String(error.message ?? '').slice(0, 4000);
  const outcome = (board.executionEngineVersion ?? ENGINE_VERSION) >= PIPELINE_CAUSE_ENGINE && text.trim()
    ? { submitOutcome: { code: error.code, text, digest: job.digest, pipelineCause: pipelineCause({ code: error.code, note: text }) } } : {};
  logEvent(board, job.agentId, 'renew', id, { leaseUntil, digest: job.digest, queuedRedReturn: true, ...outcome });
  logEvent(board, job.agentId, 'submit_handoff_returned', id, { commit: job.commit, leaseUntil });
  insertShout(board, { from: 'coordinator', to: job.agentId, text: `Queued submit #${id} was refused (${error.code}); it stays claimed by you until ${leaseUntil}. Fix it, commit and submit again; pullboard show ${id} prints the refusal and its next step.`, lanes: [] });
}

/**
 * Give a red or refused queued item back to the board: release the builder's claim and record the return with no
 * builder first refusal, so next offers it to any free seat of its lane and route.
 * Why: work belongs to the board, not to an agent; a red sat claimed by a seat whose agent was gone until its
 * two-hour lease lapsed, and the lapse then reserved it for that same seat (#3541).
 *
 * @param {any} board
 * @param {number} id
 * @param {any} job the queued job whose gate was refused
 * @param {{ code: string }} error the retained refusal
 */
function returnToBoard(board, id, job, error) {
  release(board, id, job.agentId, `the queued gate was refused (${error.code}); returned to the board for any free seat`, undefined, 'OTHER');
  logEvent(board, job.agentId, 'submit_handoff_returned', id, { commit: job.commit, returnedToBoard: true });
  insertShout(board, { from: 'coordinator', to: job.agentId, text: `Queued submit #${id} was refused (${error.code}); it went back to the board for any free seat. pullboard show ${id} prints the refusal.`, lanes: [] });
}

/** End a crashed incarnation before atomically deriving a bounded successor from its immutable candidate [C7,V4]. */
function endDeadHandoff(board, id, item, job, error, retryJob, limit = 3) {
  if (retryJob !== undefined && (!JOB.test(retryJob) || retryJob === job.id)) throw new Refused('BAD_SUBMIT_HANDOFF', 'a recovery needs a fresh job identity');
  // The ended record stays on its own job's steps, where endedSubmitHandoff reads it after the successor takes over.
  const ended = record(board, id, { ...job, state: 'infrastructure', error: { ...error }, completedAt: now(board) });
  const retries = job.recoveryRetries ?? 0;
  if (!retryJob || retries >= limit || item.item_status !== 'claimed' || item.item_owner !== job.agentId
    || item.item_frozen_digest !== job.digest || !(item.item_lease_until > now(board))
    || board.enginePorts.itemPatchDigest(board, id, job.commit) !== job.companionDigest) return ended;
  // Copy source identity, not caller-supplied candidate fields. A new id revokes every old worker's write authority.
  const next = { version: job.version, id: retryJob, agentId: job.agentId, commit: job.commit, tree: job.tree,
    main: job.main, executionCommit: job.executionCommit, executionTree: job.executionTree, digest: job.digest,
    companionDigest: job.companionDigest, leaseMs: job.leaseMs, state: 'queued', at: now(board),
    recoveryRetries: retries + 1, retryOf: job.id, ...(typeof error.reason === 'string' ? { requeuedFor: error.reason } : {}) };
  return record(board, id, next);
}

/** Persist one infrastructure stop and notify the coordinator once only after the two automatic retries [C7]. */
function recordInfrastructureStop(board, id, job, error, windowSpent = false) {
  const exhausted = windowSpent || (job.infrastructureRetries ?? 0) >= INFRASTRUCTURE_RETRY_LIMIT;
  // Only a spent runner or a dead worker is requeued by the recovery sweep; any other machine stop waits on the
  // coordinator, so it is told at once instead of the job sitting stopped unseen (#3111).
  const unrecovered = !RECOVERED_STOPS.has(error.code);
  if (exhausted && !job.infrastructureNotified) insertShout(board, { from: 'sentinel', to: 'coordinator',
    text: windowSpent
      ? `Queued gate #${id} stopped on infrastructure after the 30-minute runner retry window (${error.code}) at ${String(job.commit).slice(0, 12)}: ${String(error.message ?? '').slice(0, 300)}. Restore the runner and requeue the captured candidate. No builder red.`
      : `Queued gate #${id} exhausted ${INFRASTRUCTURE_RETRY_LIMIT} healthy-executor recovery retries (${error.code}) at ${String(job.commit).slice(0, 12)}; restore the runner and requeue the captured candidate. No builder red.`, lanes: [] });
  else if (unrecovered && !job.infrastructureNotified) insertShout(board, { from: 'sentinel', to: 'coordinator',
    text: `Queued gate #${id} stopped on the machine (${error.code}): ${error.message} Nothing is wrong with the builder's source and it keeps its claim; requeue the captured candidate once the machine recovers. No builder red.`, lanes: [] });
  return record(board, id, { ...job, state: 'infrastructure', error: { ...error }, completedAt: now(board),
    ...(windowSpent ? { infrastructureRetries: INFRASTRUCTURE_RETRY_LIMIT } : {}),
    ...(exhausted || unrecovered ? { infrastructureNotified: true } : {}) });
}

/** The machine stops the recovery sweep requeues by itself (retryStoppedHandoff); every other one needs the coordinator. */
const RECOVERED_STOPS = Object.freeze(new Set(['GATE_INFRA_EXHAUSTED', 'SUBMIT_HANDOFF_DEAD']));

/** Derive a successor only from the stopped native candidate; the caller probes health outside the writer [C7,V4]. */
function retryStoppedHandoff(board, id, job, retryJob) {
  if (!JOB.test(retryJob) || retryJob === job.id) throw new Refused('BAD_SUBMIT_HANDOFF', 'recovery needs a fresh job identity');
  const item = getItem(board, id);
  if (job.state !== 'infrastructure' || !RECOVERED_STOPS.has(job.error?.code)
    || (job.infrastructureRetries ?? 0) >= INFRASTRUCTURE_RETRY_LIMIT || item.item_status !== 'claimed' || item.item_owner !== job.agentId
    || item.item_frozen_digest !== job.digest || !(item.item_lease_until > now(board))
    || board.enginePorts.itemPatchDigest(board, id, job.commit) !== job.companionDigest) return job;
  // The stopped record is already the newest step of its own job, where endedSubmitHandoff reads it.
  const next = { ...job, id: retryJob, state: 'queued', at: now(board),
    infrastructureRetries: (job.infrastructureRetries ?? 0) + 1, retryOf: job.id,
    ...(typeof job.error?.reason === 'string' ? { requeuedFor: job.error.reason } : {}) };
  for (const field of ['error', 'completedAt', 'startedAt', 'hookProjection', 'infrastructureNotified']) delete next[field];
  return record(board, id, next);
}

/**
 * Spend the remaining retries of a stopped job whose captured tools cannot be proved or are gone, and tell the coordinator once.
 * Why: a missing capsule threw on every healthy sweep, so the job sat stopped with no count and no notice [C7,V4].
 */
function spendStoppedHandoff(board, id, job, reason) {
  if (job.state !== 'infrastructure' || (job.infrastructureRetries ?? 0) >= INFRASTRUCTURE_RETRY_LIMIT || job.infrastructureNotified) return job;
  insertShout(board, { from: 'sentinel', to: 'coordinator',
    text: `Queued gate #${id} exhausted ${INFRASTRUCTURE_RETRY_LIMIT} healthy-executor recovery retries (${job.error?.code}) at ${String(job.commit).slice(0, 12)}; its captured tools cannot be recovered (${String(reason).slice(0, 160)}). Restore the runner and requeue the captured candidate. No builder red.`, lanes: [] });
  return record(board, id, { ...job, infrastructureRetries: INFRASTRUCTURE_RETRY_LIMIT, infrastructureNotified: true });
}
