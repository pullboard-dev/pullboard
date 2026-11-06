import { INFRA_HANDOFF_RECOVERY_ENGINE } from '../../../../src/infra-handoff-recovery-engine.js';
import { DEAD_HANDOFF_RETRY_ENGINE } from '../../../state/index.js';
import {
  boardWriteSnapshot,
  requireBoardWriteSnapshot,
} from "./board-write-preparation.js";
import { insertShout } from "./board-shout.js";
import {
  submitHandoff,
  pendingSubmitHandoff,
} from "./submit-handoff-read.js";
export { submitHandoff, pendingSubmitHandoff, submitHandoffFailure } from "./submit-handoff-read.js";
/** Durable queue observations do not grant submission or review authority [C7,V4,H16]. */
import {
  atomic,
  logEvent,
} from "./board-event-log.js";
import { release } from "./board.js";
import { setItem } from "./board.js";
import {
  getItem,
  now,
  proofReceipts,
} from "./board-query.js";
import { Refused } from "../../../kernel/index.js";

/** Requeues of the same candidate after a spent gate infrastructure retry budget. */
const EXHAUSTED_RETRIES = 2;
/**
 * Error codes that stop a queued gate for infrastructure reasons, not the builder's source: a Git read that kept
 * failing (#2521), a gate whose bounded infrastructure retries were spent (#2516), and every machinery code the
 * queued worker reruns on. One set serves both sides, so a code the worker treats as infrastructure never reaches
 * the builder as a red (#3074).
 */
export const INFRASTRUCTURE_CODES = Object.freeze(new Set([
  'GIT_READ_INFRASTRUCTURE', 'GATE_INFRA_EXHAUSTED',
  'RUNNER_UNAVAILABLE', 'RUNNER_JOB_LOST', 'RUNNER_CLEANUP_TIMEOUT', 'RUNNER_WAIT_DEADLINE', 'RUNNER_INFRA_RETRY_EXHAUSTED',
  'RUNNER_BUSY', 'RUNNER_BROWSER_SLOT_REQUIRED', 'TRANSPORT_LOST', 'CLEANUP_TIMEOUT', 'SLOT_DB_LOCKED', 'BOARD_BUSY',
  'MERGE_CHECK_FAILED',
  // Accepted policy changed or became unavailable; the captured source has no test failure.
  'NO_POLICY',
]));
import { ENGINE_VERSION } from "../../../state/index.js";
import { QUEUED_RED_RETURN_ENGINE } from "../../../../src/queued-red-return-engine.js";

const PREFIX = 'submit_handoff:';
const PREPARED = new WeakMap();
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const JOB = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

/** Save within the caller's short native transaction; no filesystem or process work runs here. */
function save(board, id, value) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(PREFIX + id, JSON.stringify(value));
}

/** Keep private job identifiers and refusal text out of the public native event payload. */
function record(board, id, job) {
  logEvent(board, job.agentId, 'submit-handoff', id, { state: job.state, commit: job.commit });
  save(board, id, job);
  return structuredClone(job);
}

/** Validate the small public wait receipt so malformed worker output cannot pollute native history. */
function busyWaitReceipt(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(row => !row || typeof row.code !== 'string' || !/^[A-Z0-9_]{1,80}$/u.test(row.code)
    || !Number.isFinite(row.seconds) || row.seconds <= 0)) {
    throw new Refused('BAD_SUBMIT_HANDOFF', 'retain busy waits as code and positive seconds in the queued result');
  }
  return value.map(({ code, seconds }) => ({ code, seconds }));
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

/** Record one candidate for the existing live holder; repeated sends never schedule another gate. */
export function queueSubmitHandoff(board, id, options) {
  candidate(options);
  const prepared = board.executionEngineVersion === undefined ? prepareQueueSubmitHandoff(board, id, options) : options;
  const snapshot = PREPARED.get(prepared)?.snapshot;
  options = prepared;
  return atomic(board, () => {
    if (snapshot) requireBoardWriteSnapshot(board, snapshot, 'queueSubmitHandoff');
    const item = getItem(board, id);
    const until = Date.parse(item.item_lease_until);
    if (item.item_status !== 'claimed' || item.item_owner !== options.agentId
      || !Number.isFinite(until) || until <= Date.parse(now(board))) {
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
    const job = { version: 1, id: options.job, agentId: options.agentId, commit: options.commit,
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

/** Exactly one detached worker enters the existing canonical submit path. */
export function startSubmitHandoff(board, id, options) {
  return atomic(board, () => {
    const job = matching(board, id, options);
    if (options.hookProjection) {
      const projection = requireSubmitHandoffHookProof(board, id, job, options.hookProjection);
      return { started: false, job: record(board, id, { ...job, hookProjection: { ...projection, at: now(board) } }) };
    }
    if (options.unrecoverable) return { started: false, job: spendStoppedHandoff(board, id, job, options.unrecoverable) };
    if (options.retryJob) return { started: false, job: retryStoppedHandoff(board, id, job, options.retryJob) };
    if (job.state !== 'queued') return { started: false, job };
    const item = getItem(board, id);
    if (item.item_status !== 'claimed' || item.item_owner !== options.agentId || item.item_frozen_digest !== job.digest) {
      throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the queued claim or frozen bar changed; do not run its old gate');
    }
    return { started: true, job: record(board, id, { ...job, state: 'running', startedAt: now(board) }) };
  });
}

/** Store the canonical result without performing any submission transition or accepting new proof. */
export function completeSubmitHandoff(board, id, { result, reopenFirstRefusalMinutes, ...options }) {
  return atomic(board, () => {
    const saved = matching(board, id, options);
    if (!['queued', 'running'].includes(saved.state)) return saved;
    const busyWaits = busyWaitReceipt(result?.busyWaits);
    const job = { ...saved, ...lockWaitRecord(result?.lockWaits), ...(busyWaits ? { busyWaits } : {}) };
    const item = getItem(board, id);
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
      return record(board, id, { ...job, ...(busyWaits ? { busyWaits } : {}), state: gateGreen ? 'green' : 'submitted', gateGreen, submitted: result.commit, completedAt: now(board) });
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
    if (INFRASTRUCTURE_CODES.has(result.error.code) && item.item_status !== 'submitted') {
      // A Git read that kept failing, or runners that kept failing, is the machine's fault: the item stays claimed and the builder gets no red (#2521, #2516).
      if ((board.executionEngineVersion ?? ENGINE_VERSION) >= INFRA_HANDOFF_RECOVERY_ENGINE) return recordInfrastructureStop(board, id, job, result.error);
      insertShout(board, { from: 'sentinel', to: 'coordinator', text: `Queued gate for #${id} stopped on infrastructure (${result.error.code}); nothing is wrong with the builder's source. Resubmit it once ${result.error.code === 'GIT_READ_INFRASTRUCTURE' ? 'the Git read recovers' : 'a runner is healthy'}.`, lanes: [] });
      return record(board, id, { ...job, ...(busyWaits ? { busyWaits } : {}), state: 'infrastructure', error: { ...result.error }, completedAt: now(board) });
    }
    const state = item.item_status === 'submitted' ? 'incomplete' : 'red';
    const keeps = (board.executionEngineVersion ?? ENGINE_VERSION) >= QUEUED_RED_RETURN_ENGINE;
    if (state === 'red' && keeps && item.item_status === 'claimed' && item.item_owner === job.agentId && item.item_frozen_digest === job.digest) {
      returnToBuilder(board, id, job, result.error);
    } else if (state === 'red' && item.item_status === 'claimed' && item.item_owner === job.agentId && item.item_frozen_digest === job.digest) {
      const reservation = reopenFirstRefusalMinutes > 0
        ? board.enginePorts.firstRefusalDetail(board, { ...item, item_built_by: job.agentId }, reopenFirstRefusalMinutes)
        : { reopenFirstRefusal: { builder: job.agentId, until: new Date(board.clock.now().getTime() + job.leaseMs).toISOString() } };
      release(board, id, job.agentId, 'the queued canonical submit was refused', undefined, 'OTHER');
      logEvent(board, job.agentId, 'submit_handoff_returned', id, { commit: job.commit, ...reservation });
      insertShout(board, { from: 'coordinator', to: job.agentId, text: `Queued submit #${id} was refused (${result.error.code}); read pullboard show ${id} for the original refusal; finish or release your current build at a natural break, then claim this item.`, lanes: [] });
    }
    return record(board, id, { ...job, ...(busyWaits ? { busyWaits } : {}), state, error: { ...result.error }, completedAt: now(board) });
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
  logEvent(board, job.agentId, 'renew', id, { leaseUntil, digest: job.digest, queuedRedReturn: true });
  logEvent(board, job.agentId, 'submit_handoff_returned', id, { commit: job.commit, leaseUntil });
  insertShout(board, { from: 'coordinator', to: job.agentId, text: `Queued submit #${id} was refused (${error.code}); it stays claimed by you until ${leaseUntil}. Fix it, commit and submit again; pullboard show ${id} prints the refusal and its next step.`, lanes: [] });
}

/** End a crashed incarnation before atomically deriving a bounded successor from its immutable candidate [C7,V4]. */
function endDeadHandoff(board, id, item, job, error, retryJob, limit = 3) {
  if (retryJob !== undefined && (!JOB.test(retryJob) || retryJob === job.id)) throw new Refused('BAD_SUBMIT_HANDOFF', 'a recovery needs a fresh job identity');
  const ended = record(board, id, { ...job, state: 'infrastructure', error: { ...error }, completedAt: now(board) });
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run('submit_handoff_ended:' + job.id, JSON.stringify(ended));
  const retries = job.recoveryRetries ?? 0;
  if (!retryJob || retries >= limit || item.item_status !== 'claimed' || item.item_owner !== job.agentId
    || item.item_frozen_digest !== job.digest || !(item.item_lease_until > now(board))
    || board.enginePorts.itemPatchDigest(board, id, job.commit) !== job.companionDigest) return ended;
  // Copy source identity, not caller-supplied candidate fields. A new id revokes every old worker's write authority.
  const next = { version: job.version, id: retryJob, agentId: job.agentId, commit: job.commit, tree: job.tree,
    main: job.main, executionCommit: job.executionCommit, executionTree: job.executionTree, digest: job.digest,
    companionDigest: job.companionDigest, leaseMs: job.leaseMs, state: 'queued', at: now(board),
    recoveryRetries: retries + 1, retryOf: job.id };
  return record(board, id, next);
}

/** Persist one infrastructure stop and notify the coordinator once only after the two automatic retries [C7]. */
function recordInfrastructureStop(board, id, job, error) {
  const exhausted = (job.infrastructureRetries ?? 0) >= 2;
  if (exhausted && !job.infrastructureNotified) insertShout(board, { from: 'sentinel', to: 'coordinator',
    text: `Queued gate #${id} exhausted two healthy-executor recovery retries (${error.code}); restore the runner and requeue the captured candidate. No builder red.`, lanes: [] });
  return record(board, id, { ...job, state: 'infrastructure', error: { ...error }, completedAt: now(board),
    ...(exhausted ? { infrastructureNotified: true } : {}) });
}

/** Derive a successor only from the stopped native candidate; the caller probes health outside the writer [C7,V4]. */
function retryStoppedHandoff(board, id, job, retryJob) {
  if (!JOB.test(retryJob) || retryJob === job.id) throw new Refused('BAD_SUBMIT_HANDOFF', 'recovery needs a fresh job identity');
  const item = getItem(board, id);
  if (job.state !== 'infrastructure' || !['GATE_INFRA_EXHAUSTED', 'SUBMIT_HANDOFF_DEAD'].includes(job.error?.code)
    || (job.infrastructureRetries ?? 0) >= 2 || item.item_status !== 'claimed' || item.item_owner !== job.agentId
    || item.item_frozen_digest !== job.digest || !(item.item_lease_until > now(board))
    || board.enginePorts.itemPatchDigest(board, id, job.commit) !== job.companionDigest) return job;
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run('submit_handoff_ended:' + job.id, JSON.stringify(job));
  const next = { ...job, id: retryJob, state: 'queued', at: now(board),
    infrastructureRetries: (job.infrastructureRetries ?? 0) + 1, retryOf: job.id };
  for (const field of ['error', 'completedAt', 'startedAt', 'hookProjection', 'infrastructureNotified']) delete next[field];
  return record(board, id, next);
}

/**
 * Spend the remaining retries of a stopped job whose captured tools cannot be proved or are gone, and tell the coordinator once.
 * Why: a missing capsule threw on every healthy sweep, so the job sat stopped with no count and no notice [C7,V4].
 */
function spendStoppedHandoff(board, id, job, reason) {
  if (job.state !== 'infrastructure' || (job.infrastructureRetries ?? 0) >= 2 || job.infrastructureNotified) return job;
  insertShout(board, { from: 'sentinel', to: 'coordinator',
    text: `Queued gate #${id} exhausted two healthy-executor recovery retries (${job.error?.code}); its captured tools cannot be recovered (${String(reason).slice(0, 160)}). Restore the runner and requeue the captured candidate. No builder red.`, lanes: [] });
  return record(board, id, { ...job, infrastructureRetries: 2, infrastructureNotified: true });
}
