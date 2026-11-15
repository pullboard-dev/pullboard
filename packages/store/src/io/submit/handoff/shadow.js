/** What the START and SUBMIT tables say the hand-off writers do over the board as it stands, for a shadow compare [C7,#8279,#8280]. */
import { runSubmitTable } from "../../../logic/board/landing/lease.js";
import { submitHandoff } from "./records.js";
import { shadowSetting } from "../../board/submit.js";
import { shadowHook } from "../../board/shadow-record.js";
import { shadowDecide } from "../../board/shadow-record.js";
import { firstDifference } from "../../board/shadow-record.js";

/** The item, as the submit tables read it, from its board row (null when there is none). */
function itemOf(board, id) {
  const row = board.db.prepare('SELECT item_status, item_owner, item_lease_until, item_frozen_digest, item_lane FROM item WHERE item_id = ?').get(id);
  return row ? { id, status: row.item_status, owner: row.item_owner, leaseUntil: row.item_lease_until, frozenDigest: row.item_frozen_digest, lane: row.item_lane } : null;
}

/** A refusal's words without the `[CODE] ` prefix a thrown Refused puts on its message. */
const bare = message => String(message).replace(/^\[[A-Z0-9_]+\] /u, '');

/** What a table answer comes to for a hand-off writer: its refusal, or the record it keeps (the newest one when it writes none) and whether a gate started. */
function decision(answer, snapshot, move, withNext = false) {
  if (answer.refused) {
    // A deferred row passes the writer's own refusal through, as the table reads it from the snapshot: that refusal is the answer.
    const injected = answer.refused.code.startsWith('deferred:') ? snapshot.deferred[answer.refused.code.slice('deferred:'.length)] : null;
    return { refused: injected ? { code: injected.code, message: bare(injected.message), ...(withNext ? { next: injected.next } : {}) } : { code: answer.refused.code, message: answer.refused.message, ...(withNext ? { next: answer.refused.next } : {}) } };
  }
  const outcome = answer.table.outcomes.find(entry => entry.id === answer.via[0]);
  return { via: answer.via[0], job: outcome.record ? outcome.record(snapshot, move) : snapshot.handoff };
}

/**
 * What the START table says starting, resuming, hooking or recovering a hand-off does: `{ refused }`, or `{ via, job }`.
 * `limits` is the store's retry limit and infrastructure codes, which the table takes by injection, and `hookProblem` the writer's own merge-hook proof check (a refusal `{ code, message, next }` or null).
 * Why: the writer's own checks and the table must give one answer, and the shadow compare shows it [C7,#8279].
 */
export function startDecision(board, id, options, limits, hookProblem) {
  const { answer, snapshot, move } = startAnswer(board, id, options, limits, hookProblem);
  return decision(answer, snapshot, move);
}

/** The START table run over the board as it stands, with the snapshot and move it read. */
function startAnswer(board, id, options, limits, hookProblem) {
  const handoff = submitHandoff(board, id);
  const snapshot = { now: board.clock.now().toISOString(), actor: { id: options.agentId }, item: itemOf(board, id), handoff,
    io: { companionDigest: options.retryJob && handoff ? board.enginePorts.itemPatchDigest(board, id, handoff.commit) : null },
    deferred: { hookProofProblem: options.hookProjection && handoff ? hookProblem() : null } };
  const move = { id, actor: options.agentId, job: options.job,
    ...(options.hookProjection ? { hook: options.hookProjection } : {}),
    ...(options.unrecoverable ? { unrecoverable: options.unrecoverable } : {}),
    ...(options.retryJob ? { retryJob: options.retryJob } : {}) };
  return { answer: runSubmitTable('START', limits, snapshot, move), snapshot, move };
}

/**
 * What the START table decides for a live hand-off start: `{ refused: { code, message, next } }`, or `{ via, job, events }`, the record it keeps and the events it writes.
 * Why a second reader beside startDecision: the live writer needs the refusal's next step and the events, which the shadow compare leaves out [C7,#8385].
 */
export function liveStartDecision(board, id, options, limits, hookProblem) {
  const { answer, snapshot, move } = startAnswer(board, id, options, limits, hookProblem);
  if (answer.refused) {
    const injected = answer.refused.code.startsWith('deferred:') ? snapshot.deferred[answer.refused.code.slice('deferred:'.length)] : null;
    return { refused: injected ? { code: injected.code, message: bare(injected.message), next: injected.next } : { code: answer.refused.code, message: answer.refused.message, next: answer.refused.next } };
  }
  const outcome = answer.table.outcomes.find(entry => entry.id === answer.via[0]);
  return { via: answer.via[0], job: outcome.record ? outcome.record(snapshot, move) : snapshot.handoff, events: answer.events };
}

/**
 * What the SUBMIT table says queuing a gate does: `{ refused }`, or `{ via, job }` (`queue`, or `queue-existing` with the pending job).
 * Only the queue rows are compared: the digest the caller captured against the frozen one stays the writer's own check.
 * Why: the writer's own checks and the table must give one answer, and the shadow compare shows it [C7,#8280].
 */
export function queueDecision(board, id, options, limits, withNext = false) {
  const item = itemOf(board, id);
  const children = board.db.prepare('SELECT item_id, item_status FROM item WHERE item_parent_id = ?').all(id).map(row => ({ id: row.item_id, status: row.item_status }));
  const snapshot = { now: board.clock.now().toISOString(), config: { handoff: true, leaseMs: options.leaseMs }, actor: { id: options.agentId, joined: true, lane: item?.lane },
    item, children, rejects: [], history: [], submits: [], receipts: [], handoff: submitHandoff(board, id),
    io: { head: { commit: options.commit, tree: options.tree, main: options.main, executionCommit: options.executionCommit, executionTree: options.executionTree },
      companionDigest: options.companionDigest }, deferred: {}, gate: null };
  const move = { id, actor: options.agentId, job: options.job };
  return decision(runSubmitTable('SUBMIT', limits, snapshot, move), snapshot, move, withNext);
}

/**
 * Run a hand-off writer with its table shadowed: the board's own hook (a store test), else, with moves.shadow on, a recorder
 * that counts `record.differs(answer)` under `record.table`, else the writer alone. The table's answer and what the writer
 * returned or refused with go to the hook; a board the table does not model (`modelled` false) runs the writer alone.
 * The setting is read here, before the writer's own board write opens, so no file I/O runs inside it [C7,#8379].
 */
export function shadowed(board, hook, id, modelled, decide, write, record) {
  const live = !modelled ? null : record ? shadowHook(board, hook, record.table, record.differs, shadowSetting) : typeof board[hook] === 'function' ? board[hook] : null;
  if (!live) return write();
  const decided = shadowDecide(live, decide);
  let wrote;
  try { wrote = { returned: write() }; } catch (error) { wrote = { refused: { code: error.code, message: bare(error.message) }, error }; }
  live({ id, decided, wrote: wrote.refused ? { refused: wrote.refused } : { returned: wrote.returned } });
  if (wrote.error) throw wrote.error;
  return wrote.returned;
}

/** Where the SUBMIT table's queue answer and the queue writer's part: the refusals, or else the kept hand-off record. */
export function queueDiffers({ decided, wrote }) {
  if (decided?.threw) return `threw ${decided.threw}`;
  if (decided?.refused || wrote.refused) return firstDifference(decided?.refused ?? null, wrote.refused ?? null, 'refused') ?? 'refused';
  const via = wrote.returned.created ? 'queue' : 'queue-existing';
  if (decided.via !== via) return 'via';
  return firstDifference(decided.job, JSON.parse(JSON.stringify(wrote.returned.job)), 'job');
}
