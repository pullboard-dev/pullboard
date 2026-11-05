import { withHandoffQueueOrder } from '../../../../packages/resources/index.js';
import { ensureHandoffDispatcher } from '../../../../packages/resources/index.js';
import { queueHandoffLaunch } from '../../../../packages/resources/index.js';
import { reserveHandoffTicket } from '../../../../packages/resources/index.js';
import { handoffTicketWaiting } from '../../../../packages/resources/index.js';
import { prepareDeadHandoffRetry } from '../../../../packages/items/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { git } from '../../../../packages/git/index.js';
import { exactStart } from '../../../../packages/gate/index.js';
/** Queue only after canonical Submit has checked the exact source, lane, bar and companion composition [V4]. */
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  cpSync,
  realpathSync,
  readFileSync,
  existsSync,
  constants,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  relative,
  basename,
} from 'node:path';
import { tmpdir } from 'node:os';
import { Refused } from '../../../../packages/kernel/index.js';
import { refusalDocument } from '../core/next-step-words.js';
import { submitHandoff } from '../../../../packages/store/index.js';
import { itemUrgent } from '../../../../packages/store/index.js';
import { withBoardRead } from './cli-context.js';
import { withBoard } from './cli-context.js';
import { ordered } from './cli/claim.js';
import { itemPatchDigest } from '../../../../packages/items/index.js';
import { submitHandoffRoot } from './submit-handoff-origin.js';

/** Persist the immutable native request before detaching one worker; acknowledgment is not gate green. */
export async function enqueueSubmitHandoff(ctx, item, me, candidate) {
  const result = await withHandoffQueueOrder(() => withBoard(ctx, async board => {
    const queued = await ordered(ctx, board, 'queueSubmitHandoff', [item.item_id, {
    agentId: me.id, job: randomUUID(), main: candidate.main, executionCommit: candidate.companion?.commit ?? candidate.commit, executionTree: candidate.companion?.tree ?? candidate.tree, commit: candidate.commit, tree: candidate.tree,
    digest: item.item_frozen_digest, leaseMs: ctx.config.leaseMs, companionDigest: itemPatchDigest(board, item.item_id, candidate.commit),
  }]);
    // Keep the native move and reservation inside the machine ordering lock, before capture.
    return queued.created ? { ...queued, reservation: await reserveHandoffTicket(queued.job.id, { startOf: exactStart, urgent: itemUrgent(board, item.item_id) }) } : queued;
  }));
  const directory = dirname(submitHandoffRoot(ctx.info.commonDir, result.job));
  if (result.created) {
    git(ctx.info.root, ['update-ref', `refs/pullboard/submit-handoffs/${result.job.id}`, result.job.commit]);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Snapshot the running Pullboard build separately from the submitted project.
    // An external project need not contain Pullboard's own executable at all.
    const toolRoot = dirname(dirname(dirname(dirname(dirname(ctx.io.submitHandoffWorker)))));
    const tools = mkdtempSync(join(tmpdir(), `pullboard-handoff-tools-${result.job.id}-`));
    cpSync(toolRoot, tools, { recursive: true, mode: constants.COPYFILE_FICLONE,
      filter: path => !['.git', 'node_modules'].includes(relative(toolRoot, path).split('/')[0]) });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ item: item.item_id, job: result.job.id,
      commonDir: ctx.info.commonDir, origin: ctx.info.root, commit: result.job.commit, infra: candidate.infra,
      companion: candidate.companion, tools }) + '\n', { flag: 'wx', mode: 0o600 });
    await launchCapturedWorker(directory, tools, ctx.info.commonDir, result.job, 0, result.reservation);
  } else {
    await recoverSubmitHandoff(ctx, item.item_id, me.id, result.job);
  }
  const current = withBoardRead(ctx, board => submitHandoff(board, item.item_id));
  if (current?.id === result.job.id && current.state === 'red') throw new Refused(current.error.code, current.error.message, current.error.next);
  const acknowledgment = { queued: true, id: item.item_id, item: item.item_id, pin: `refs/pullboard/submit-handoffs/${result.job.id}`, gate: { queued: true, green: null }, commit: result.job.commit, tree: result.job.tree,
    companionDigest: result.job.companionDigest, state: result.job.state };
  if (ctx.submissionResult) Object.assign(ctx.submissionResult,
    { queued: true, job: result.job.id, value: acknowledgment });
  ctx.io.result?.(acknowledgment);
  ctx.io.say(`queued gate for #${item.item_id} at ${result.job.commit}; the board will wake the next actor when it finishes`);
  return 0;
}

/** Queue every initial or recovery launch behind the same machine cap, without spawning a waiting worker. */
async function launchCapturedWorker(directory, tools, commonDir, job, relaunches = 0, reservation) {
  const ticket = reservation ?? await reserveHandoffTicket(job.id, { startOf: exactStart });
  queueHandoffLaunch({ directory, tools, commonDir, job: job.id, relaunches }, ticket);
  await ensureHandoffDispatcher(tools, commonDir, { startOf: exactStart });
}

/** An absent process, a different exact incarnation or a worker the dispatcher could not start proves death; unavailable identity never does. */
function deadWorker(worker, job) {
  if (worker?.job === job.id && worker.unstarted && worker.pid === null) return true;
  if (worker?.job !== job.id || !Number.isSafeInteger(worker.pid) || worker.pid < 1) return false;
  try { process.kill(worker.pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  const observed = exactStart(worker.pid);
  return Boolean(worker.started && observed && observed !== worker.started);
}

/** A queued job past its launch grace with no worker record and no place in line will never start. */
export const LOST_LAUNCH_GRACE_MS = 2 * 60_000;

/**
 * Whether a queued job's launch was lost: it is older than the grace, so its submit reserved a place long ago, yet no
 * place in line remains. Why: the dispatcher writes worker.json before it removes a ticket, so only a lost ticket
 * (an abandoned reservation or a ticket kept aside) leaves neither, and such a job held its claim for 5 h (#3121).
 */
export function lostQueuedLaunch(job, { now = Date.now(), waiting = handoffTicketWaiting } = {}) {
  const at = Date.parse(job?.at ?? '');
  return job?.state === 'queued' && Number.isFinite(at) && now - at > LOST_LAUNCH_GRACE_MS && !waiting(job.id);
}

/**
 * Recover only this authenticated builder's unfinished job, queued or running, outside the native writer. Why running
 * too: a worker that died mid-gate (#2469, ITEM_LEASE_LOST) left its job running forever, refusing every resubmit.
 */
async function recoverSubmitHandoff(ctx, itemId, actor, observed) {
  if (observed?.agentId !== actor || !['queued', 'running'].includes(observed.state)) return;
  const directory = dirname(submitHandoffRoot(ctx.info.commonDir, observed));
  return withFileLock(join(directory, 'recovery.guard.sqlite'), () => recoverDeadSubmitHandoff(ctx, itemId, actor, observed, directory));
}

/** Re-observe under the per-job OS-released lock before any spawn or native failure move. */
async function recoverDeadSubmitHandoff(ctx, itemId, actor, observed, directory) {
  let worker;
  try { worker = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8')); }
  catch {
    if (!lostQueuedLaunch(observed)) return;
    worker = { version: 1, job: observed.id, pid: null, started: null, relaunches: 0,
      unstarted: { code: 'HANDOFF_TICKET_LOST', message: 'the queued job has no worker record and no place in line' } };
  }
  if (!deadWorker(worker, observed)) return;
  let owned = false;
  const current = withBoardRead(ctx, board => {
    const item = board.db.prepare('SELECT item_status,item_owner,item_frozen_digest FROM item WHERE item_id=?').get(itemId);
    const job = submitHandoff(board, itemId);
    owned = item?.item_status === 'claimed' && item.item_owner === actor && item.item_frozen_digest === observed.digest;
    return job?.id === observed.id && job.state === observed.state ? job : null;
  });
  if (!current) return;
  try {
    // A dead job on an item its seat no longer holds (released, withdrawn) still ends; it never shows running (#2627).
    if (!owned) throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'the item is no longer claimed by the seat that queued it');
    // A running job may have written its private source and board moves; only a queued one is safe to relaunch.
    if (current.state === 'running') throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'the running worker exited without a terminal result');
    if (worker.relaunches >= 1) throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'the captured worker exited again after its recovery launch');
    const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
    if (request.job !== current.id || request.item !== itemId || request.commit !== current.commit || request.commonDir !== ctx.info.commonDir
      || !basename(request.tools ?? '').startsWith(`pullboard-handoff-tools-${current.id}-`)
      || dirname(realpathSync(request.tools)) !== realpathSync(tmpdir())
      || existsSync(submitHandoffRoot(ctx.info.commonDir, current))) {
      throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'the dead queued worker lacks safe captured tooling or already has a private source; preserve its evidence and resubmit the captured commit');
    }
    await launchCapturedWorker(directory, request.tools, ctx.info.commonDir, current, 1);
    ctx.io.say(`relaunched queued submit #${itemId} from its captured tools`);
    return;
  } catch (error) {
    let retry = null;
    if (owned && current.state === 'running') {
      try { retry = prepareDeadHandoffRetry(ctx.info.commonDir, itemId, current, directory); }
      catch (preparation) { ctx.io.err(`stopped submit #${itemId} cannot retry captured tools: ${preparation.message}`); }
    }
    const failure = { code: 1, ...refusalDocument(new Refused('SUBMIT_HANDOFF_DEAD',
      `${current.state} submit worker is dead and cannot be relaunched: ${error.message}; the gate stopped on infrastructure, never a builder red`,
      'the health sweep retries the captured candidate within its retry budget; the coordinator restores missing tools'), { caller: 'seat' }) };
    writeFileSync(join(directory, 'refusal.json'), JSON.stringify(failure) + '\n', { mode: 0o600 });
    let ended;
    try {
      ended = await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [itemId,
        { agentId: actor, job: current.id, result: failure, ...(retry ? { retryJob: retry.id } : {}), reopenFirstRefusalMinutes: ctx.config.claim?.reopenFirstRefusalMinutes }]));
    } catch (completion) { retry?.discard(); throw completion; }
    if (retry && (ended?.id !== retry.id || ended.state !== 'queued')) retry.discard();
    if (retry && ended?.id === retry.id && ended.state === 'queued') {
      try { await launchCapturedWorker(retry.directory, retry.tools, ctx.info.commonDir, ended); }
      catch (launch) {
        ctx.io.err(`stopped submit #${itemId} recovery launch failed: ${launch.message}`);
        await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [itemId,
          { agentId: actor, job: ended.id, result: failure }]));
      }
    }
  }
}

/**
 * The health sweep ends every queued or running handoff on the board whose worker process is gone, whichever seat
 * queued it and whatever its item's state now. Why: recovery ran only when the queuing seat itself ran next or submit
 * on an item it still held, so a seat that stopped, or an item released or withdrawn, left its job running for hours
 * (#2627). A live worker, or one whose identity cannot be read, is left alone.
 */
export async function sweepDeadSubmitHandoffs(ctx) {
  const jobs = withBoardRead(ctx, board => board.db.prepare("SELECT meta_key FROM board_meta WHERE meta_key GLOB 'submit_handoff:*'").all()
    .map(row => Number(row.meta_key.slice('submit_handoff:'.length))).filter(Number.isSafeInteger)
    .map(itemId => ({ itemId, job: submitHandoff(board, itemId) })).filter(row => ['queued', 'running'].includes(row.job?.state)));
  for (const { itemId, job } of jobs) await recoverSubmitHandoff(ctx, itemId, job.agentId, job);
  return jobs.length;
}

/** Next may recover this seat's queued or running claims whose worker is gone, never another seat's or a live gate. */
export async function recoverOwnSubmitHandoffs(ctx, actor) {
  const jobs = withBoardRead(ctx, board => board.db.prepare("SELECT item_id FROM item WHERE item_status='claimed' AND item_owner=?").all(actor)
    .map(row => ({ itemId: row.item_id, job: submitHandoff(board, row.item_id) })).filter(row => ['queued', 'running'].includes(row.job?.state)));
  for (const { itemId, job } of jobs) await recoverSubmitHandoff(ctx, itemId, actor, job);
}

/**
 * Before a submit compares sources, retire this seat's own handoff for the item when its worker is gone, so a dead
 * job never refuses the next submit with SUBMIT_HANDOFF_PENDING; a live worker is left alone.
 */
export async function recoverItemSubmitHandoff(ctx, itemId, actor) {
  const job = withBoardRead(ctx, board => submitHandoff(board, itemId));
  await recoverSubmitHandoff(ctx, itemId, actor, job);
}

/**
 * Stop a replaced worker's process group only when it is provably the recorded incarnation: it has a recorded start
 * time and a fresh exact start read right before the signal equals it. Why: a missing start, a reused PID or an
 * unreadable start could name another process; such a worker is left to end on its own (#2592). Returns whether it signaled.
 *
 * @param {{ job?: string, pid?: number, started?: string } | null} worker
 * @param {{ id: string }} job
 * @param {{ startOf?: (pid: number) => string | null, kill?: (pid: number, signal: string) => void }} [ports]
 */
export function stopReplacedWorker(worker, job, { startOf = exactStart, kill = process.kill.bind(process) } = {}) {
  if (worker?.job !== job.id || !Number.isSafeInteger(worker.pid) || worker.pid <= 1 || typeof worker.started !== 'string' || !worker.started) return false;
  let observed = null;
  try { observed = startOf(worker.pid); } catch { return false; }
  if (!observed || observed !== worker.started) return false;
  try { kill(-worker.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
  return true;
}

/**
 * A newer head replaces this seat's queued or running gate for the item: its worker's process group is stopped when it
 * is provably the recorded incarnation, which frees its gate and runner slot, and the job ends with SUBMIT_HANDOFF_REPLACED. Why: waiting on a gate whose source is
 * already superseded cost builders about 15 minutes each (#2592). Returns null, so the caller queues the new head.
 */
export async function replaceSubmitHandoff(ctx, itemId, actor, job) {
  if (job?.agentId !== actor || !['queued', 'running'].includes(job.state)) return job;
  const directory = dirname(submitHandoffRoot(ctx.info.commonDir, job));
  await withFileLock(join(directory, 'recovery.guard.sqlite'), async () => {
    let worker = null;
    try { worker = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8')); } catch { /* A queued job may not have launched yet. */ }
    // The worker leads its own detached process group; the group holds its gate, its runner connection and its slot.
    stopReplacedWorker(worker, job);
    const failure = { code: 1, ...refusalDocument(new Refused('SUBMIT_HANDOFF_REPLACED',
      `a newer head replaced this gate at ${job.commit.slice(0, 12)}`, 'read the newer gate with pullboard show <id>'), { caller: 'seat' }) };
    writeFileSync(join(directory, 'refusal.json'), JSON.stringify(failure) + '\n', { mode: 0o600 });
    await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [itemId,
      { agentId: actor, job: job.id, result: failure, reopenFirstRefusalMinutes: ctx.config.claim?.reopenFirstRefusalMinutes }]));
  });
  ctx.io.say(`replaced the queued gate for #${itemId} at ${job.commit.slice(0, 12)}; the new head gates instead`);
  return null;
}
