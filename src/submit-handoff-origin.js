import { mainPolicy, policyAt } from './trusted-policy-read.js';
import { contains } from './git.js';
import { itemPatchDigest } from './item-patch-state.js';
/** Private worker origins retain the queued sender without registering or lending a second seat [E18,V4]. */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { repoInfo, headCommit, headTree, isClean } from './git.js';
import { submitHandoff } from './submit-handoff-read.js';
import { Refused } from './refused.js';

const CONTEXTS = new WeakMap();
const BOARDS = new WeakMap();
const WRITES = new Set(['claim', 'recordProofRun', 'recordGateRun', 'recordFlakeObservation', 'appendFact', 'shout', 'submit', 'completeSubmitHandoff', 'startSubmitHandoff']);

/** Derive the private source location from native queue identity, never a caller-selected repository. */
export function submitHandoffRoot(commonDir, job) {
  return join(commonDir, 'pullboard', 'submit-handoffs', job.id, 'source');
}

/** Install finite worker authority only after checking the exact native queued source on this board. */
export function bindSubmitHandoffOrigin(ctx, board, itemId, jobId) {
  const job = submitHandoff(board, itemId);
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(itemId);
  if (!job || job.id !== jobId || !['queued', 'running'].includes(job.state) || item?.item_owner !== job.agentId
    || item.item_status !== 'claimed' || item.item_frozen_digest !== job.digest
    || realpathSync(ctx.info.root) !== realpathSync(submitHandoffRoot(ctx.info.commonDir, job))
    || repoInfo(ctx.info.root).commonDir !== ctx.info.commonDir || !isClean(ctx.info.root)
    || headCommit(ctx.info.root) !== job.commit || headTree(ctx.info.root) !== job.tree) {
    throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the worker needs the exact native queued candidate on its own board');
  }
  CONTEXTS.set(ctx, { itemId, jobId, actor: job.agentId, root: ctx.info.root, main: job.main, executionCommit: job.executionCommit, executionTree: job.executionTree });
}

/** Recheck native ownership and frozen identity on each worker read or write. */
export function submitHandoffActor(ctx, board, operation, args) {
  const origin = CONTEXTS.get(ctx);
  if (!origin) return null;
  const job = submitHandoff(board, origin.itemId);
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(origin.itemId);
  if (!job || job.id !== origin.jobId || job.agentId !== origin.actor || !['queued', 'running'].includes(job.state)
    || item?.item_frozen_digest !== job.digest || itemPatchDigest(board, origin.itemId, job.commit) !== job.companionDigest
    || !(item.item_status === 'claimed' && item.item_owner === origin.actor
      || item.item_status === 'submitted' && item.item_built_by === origin.actor && (!operation || ['completeSubmitHandoff', 'appendFact', 'shout'].includes(operation)))) {
    throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the queued owner or frozen bar changed; the old worker cannot act');
  }
  if (operation && (job.state === 'queued' && !['startSubmitHandoff', 'completeSubmitHandoff'].includes(operation) || !WRITES.has(operation) || !workerMoveMatches(origin, operation, args))) {
    throw new Refused('SUBMIT_HANDOFF_AUTHORITY', 'a queued worker may only finish its own captured submission');
  }
  BOARDS.set(board, origin);
  return board.db.prepare('SELECT * FROM agent WHERE agent_id=?').get(origin.actor);
}

/** Constrain every write to this sender and item; normal move guards remain authoritative. */
function workerMoveMatches(origin, operation, args) {
  if (operation === 'recordFlakeObservation') {
    const value = args[0];
    return value?.agentId === origin.actor && value.observation?.kind === 'submit'
      && value.observation.head === origin.executionCommit && value.observation.tree === origin.executionTree
      && value.observation.main === origin.main;
  }
  if (operation === 'recordProofRun') return args[0]?.agentId === origin.actor && args[0]?.itemId === origin.itemId;
  if (operation === 'recordGateRun') return args[0]?.agentId === origin.actor && args[0]?.receipt?.proof?.item === origin.itemId;
  if (operation === 'shout') return args[0]?.from === origin.actor && args[0]?.item === origin.itemId;
  return args[0] === origin.itemId && args[1]?.agentId === origin.actor;
}

/** The origin sealer may use only the connection-local worker capability, never supplied wire metadata. */
export function submitHandoffBoardRoot(board, itemId, actor) {
  const origin = BOARDS.get(board);
  return origin?.itemId === itemId && origin.actor === actor ? origin.root : null;
}

/** Detect an internally bound worker without accepting environment or CLI identity overrides. */
export function isSubmitHandoffWorker(ctx) { return CONTEXTS.has(ctx); }

/** Preserve finite worker authority when canonical Submit derives its frozen policy context. */
export function copySubmitHandoffOrigin(source, target) {
  const origin = CONTEXTS.get(source);
  if (origin) CONTEXTS.set(target, origin);
  return target;
}

/** Retain only the genuinely captured accepted policy; a force-moved trunk cannot revive old authority. */
export function submitHandoffPolicy(ctx) {
  const origin = CONTEXTS.get(ctx);
  if (!origin) return null;
  if (!contains(ctx.info.root, origin.main, mainPolicy(ctx.info.root).commit)) throw new Refused('SUBMIT_HANDOFF_CHANGED', 'current main no longer contains the queued accepted policy');
  return policyAt(ctx.info.root, origin.main);
}

/** Require the captured execution tree again after canonical companion preparation, before any proof. */
export function requireSubmitHandoffExecution(ctx, board, commit, tree) {
  const origin = CONTEXTS.get(ctx);
  if (!origin) return;
  submitHandoffActor(ctx, board);
  const job = submitHandoff(board, origin.itemId);
  if (job.executionCommit !== commit || job.executionTree !== tree) throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the deterministic composition differs from the immutable queued execution source');
}
