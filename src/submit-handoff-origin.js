import { requireSubmitHandoffHookProof } from './submit-handoff-state.js';
import {
  mainPolicy,
  policyAt,
} from '../packages/sandbox/index.js';
import { contains } from './git.js';
import { itemPatchDigest } from './item-patch-state.js';
import { agentById } from './board-query.js';
/** Private worker origins retain the queued sender without registering or lending a second seat [E18,V4]. */
import { realpathSync } from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  repoInfo,
  headCommit,
  headTree,
  isClean,
  git,
  tryGit,
  untracked,
} from './git.js';
import { submitHandoff } from './submit-handoff-read.js';
import { Refused } from '../packages/kernel/index.js';

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
  return agentById(board, origin.actor);
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

/** Project only a real running job's proved actor while Git holds the exact accepted-main merge index. */
export function submitHandoffHookActor(ctx, board) {
  const prefix = resolve(ctx.info.commonDir, 'pullboard', 'submit-handoffs') + '/';
  if (!resolve(ctx.info.root).startsWith(prefix)) return null;
  const entry = board.db.prepare("SELECT meta_key,meta_value FROM board_meta WHERE meta_key LIKE 'submit_handoff:%'").all()
    .map(row => ({ id: Number(row.meta_key.slice('submit_handoff:'.length)), job: JSON.parse(row.meta_value) }))
    .find(({ job }) => resolve(submitHandoffRoot(ctx.info.commonDir, job)) === resolve(ctx.info.root));
  if (!entry) throw new Refused('SUBMIT_HANDOFF_AUTHORITY', 'the hook source is not the exact native queued job');
  const { id, job } = entry;
  requireSubmitHandoffHookProof(board, id, job, job.hookProjection);
  const main = mainPolicy(ctx.info.root).commit;
  const mergeHead = tryGit(ctx.info.root, ['rev-parse', '--verify', 'MERGE_HEAD']);
  // Git invokes pre-merge-commit before writing MERGE_HEAD; these are candidate SHAs, never actor authority.
  const names = Object.keys(process.env).filter(name => name.startsWith('GITHEAD_'));
  const candidates = names.every(name => /^GITHEAD_[a-f0-9]{40}$/u.test(name))
    ? names.map(name => name.slice('GITHEAD_'.length)) : [];
  const merge = mergeHead.status === 0 ? mergeHead.stdout.trim() : candidates.length === 1 ? candidates[0] : null;
  const source = headCommit(ctx.info.root);
  const expected = git(ctx.info.root, ['merge-tree', '--write-tree', source, main]).split('\n')[0];
  if (realpathSync(ctx.info.root) !== realpathSync(submitHandoffRoot(ctx.info.commonDir, job))
    || source !== job.executionCommit || headTree(ctx.info.root) !== job.executionTree || merge !== main
    || !contains(ctx.info.root, job.main, main) || git(ctx.info.root, ['write-tree']) !== expected
    || git(ctx.info.root, ['diff', '--name-only']).trim() || untracked(ctx.info.root).length) {
    throw new Refused('SUBMIT_HANDOFF_AUTHORITY', 'the job hook accepts only its proved source and exact current accepted-main merge tree');
  }
  return agentById(board, job.agentId);
}
