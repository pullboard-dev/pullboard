import { refusalDocument } from '../../../../src/next-step-words.js';
/** A gate's driver runs canonical Submit from its captured private source, never the builder checkout [C7]. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import {
  dirname,
  basename,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { gitSpawnSync } from '../../../../src/git-adapter.js';
import { cleanGitEnvironment } from '../../../../src/git.js';
import {
  context,
  withBoard,
} from '../../../../src/cli-context.js';
import { ordered } from '../../../../src/cli/claim.js';
import {
  bindSubmitHandoffOrigin,
  submitHandoffRoot,
  isSubmitHandoffWorker,
} from '../../../../src/submit-handoff-origin.js';
import { submitHandoff } from '../../../../src/submit-handoff-read.js';
import { submitHere } from '../../../../src/commands/submit.js';
import { Refused } from '../../../../packages/kernel/index.js';
import * as store from '../../../../packages/store/index.js';
import { acceptedCellsFromJob } from './main-audit-produce.js';
import { submitUntilSettled } from './submit-infra-requeue.js';
import { runGateStages } from '../../../../packages/gate/index.js';
import { drainLoop } from '../../../../packages/drive/index.js';
import { gateDriveJobId } from '../../../../packages/drive/index.js';
import { GATE_DRIVE_KIND } from '../../../../packages/drive/index.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { nameJob } from '../../../../packages/jobs/index.js';
import { finishJob } from '../../../../packages/jobs/index.js';

/** Keep Git operations on the native common repository even if the builder removes its checkout. */
function jobGit(commonDir, args) {
  const result = gitSpawnSync(['--git-dir', commonDir, ...args], { env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Refused('SUBMIT_HANDOFF_SOURCE', `queued source Git ${args[0]} failed: ${String(result.stderr ?? '').slice(0, 1000)}`);
  return result.stdout.trim();
}

/** Read an owned request location without treating its paths as actor authority. */
function workerRequest(requestFile) {
  const request = JSON.parse(readFileSync(requestFile, 'utf8'));
  const directory = dirname(resolve(requestFile));
  const root = join(directory, 'source');
  if (root !== submitHandoffRoot(request.commonDir, { id: request.job })) throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the request does not name its native job directory');
  return { request, directory, root };
}

/** Pure source/claim predicate shared by admission and its contract regression. */
export function submitHandoffClaimProblem(request, job, item, now) {
  if (job?.id !== request.job || job.state !== 'running' || job.commit !== request.commit) {
    return 'queued submit dropped: its original job or captured commit is no longer current';
  }
  if (!item || item.item_status !== 'claimed' || item.item_owner !== job.agentId || item.item_frozen_digest !== job.digest
    || !(Date.parse(item.item_lease_until) > now)) {
    return `queued submit dropped: #${request.item} is no longer claimed by ${job.agentId} at its frozen bar`;
  }
  return null;
}

/** Revalidate the immutable native queue and its live claimant immediately before each runner admission. */
export function assertCurrentSubmitHandoff(ctx, request) {
  const current = withBoard(ctx, board => {
    const job = submitHandoff(board, request.item);
    let item = null;
    try { item = store.getItem(board, request.item); } catch (error) { if (error?.code !== 'NO_ITEM') throw error; }
    return { job, item, now: board.clock.now().getTime() };
  });
  const problem = submitHandoffClaimProblem(request, current.job, current.item, current.now);
  if (problem) throw new Refused('SUBMIT_HANDOFF_CHANGED', problem);
  return true;
}

/** Bind this process to the exact native queue before it can record even a failure. */
function workerContext(request, directory, root, nativeBoard) {
  const ctx = context({ cwd: root, nativeBoard, relayJson: true,
    say: line => process.stdout.write(String(line) + '\n'),
    err: line => process.stderr.write(String(line) + '\n'),
    result: value => { writeFileSync(join(directory, 'submission.json'), JSON.stringify(value) + '\n', { mode: 0o600 }); } });
  const job = withBoard(ctx, board => submitHandoff(board, request.item));
  if (!job || job.id !== request.job) throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the original queued request is no longer current');
  withBoard(ctx, board => bindSubmitHandoffOrigin(ctx, board, request.item, request.job));
  ctx.submitHandoffAdmissionCheck = () => assertCurrentSubmitHandoff(ctx, request);
  return { ctx, job };
}

/** Retain a refusal and return only this process's still-current native job through the normal move. */
async function recordWorkerFailure(ctx, request, directory, failure) {
  writeFileSync(join(directory, 'refusal.json'), JSON.stringify(failure) + '\n', { mode: 0o600 });
  if (ctx && isSubmitHandoffWorker(ctx)) {
    try {
      const job = withBoard(ctx, board => submitHandoff(board, request.item));
      if (job?.id === request.job && ['queued', 'running'].includes(job.state)) {
        await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [request.item,
          { agentId: job.agentId, job: job.id, result: failure, reopenFirstRefusalMinutes: ctx.config.claim?.reopenFirstRefusalMinutes }]));
      }
    } catch (recordingError) { process.stderr.write(`queued result was not recorded: ${recordingError.message}\n`); }
  }
}

/**
 * Remove only the executing job's own temporary tool snapshot, including aliased temporary roots. A shared commit
 * snapshot is never named for one job, so it stays for every other queued or running gate that names it [C7].
 *
 * @param {{ job: string, tools?: string }} request - The executing job's captured request.
 * @param {string} [tools] - The running tools folder; defaults to the folder this module was loaded from.
 */
export function cleanupToolSnapshot(request, tools = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))))) {
  if (basename(tools).startsWith(`pullboard-handoff-tools-${request.job}-`)
    && dirname(realpathSync(tools)) === realpathSync(tmpdir())
    && request.tools && realpathSync(request.tools) === realpathSync(tools)) {
    rmSync(tools, { recursive: true, force: true });
  }
}

/**
 * Wait for a commit's accepted cells inventory through its cells-inventory job on the board, on a board handle of
 * its own so a minutes-long production never holds a command's board open.
 *
 * @param {any} nativeBoard - The native board module, which opens the board file.
 * @param {any} ctx - The worker's context; its file is the board.
 * @param {string} root - The disposable source checkout.
 * @param {string} commit - The pinned main commit the gate needs the inventory of.
 * @param {string} job - The submit hand-off job, named in the inventory job's lease owner.
 */
async function inventoryFromJob(nativeBoard, ctx, root, commit, job) {
  const board = nativeBoard.openBoard(ctx.file);
  try { return await acceptedCellsFromJob(board.db, root, commit, { owner: `gate:${job}:${process.pid}`, beat: line => process.stderr.write(line + '\n') }); }
  finally { store.closeBoard(board); }
}

/**
 * The result the hand-off worker records for a gate that went green: the submitted commit, plus how long it waited
 * on busy locks and the owner it waits on, when either applies.
 *
 * @param {any} ctx - The worker's context, holding the submission result.
 * @param {{ count: number }} lockWaits
 */
export function handoffGreenResult(ctx, lockWaits) {
  return { code: 0, commit: ctx.submissionResult.value?.commit, ...(lockWaits.count ? { lockWaits } : {}),
    ...(ctx.submissionResult.value?.waitingOwner ? { ownershipWait: ctx.submissionResult.value.waitingOwner.key } : {}) };
}

/**
 * The result the hand-off worker records for a refused gate. Lock waits ride on the refusal too, so the job shows how
 * long the gate waited on a busy lock (#3087).
 *
 * @param {any} error - The gate's refusal.
 */
export function handoffRefusedResult(error) {
  return { code: 1, ...refusalDocument(error, { caller: 'seat' }), ...(error?.lockWaits ? { lockWaits: error.lockWaits } : {}) };
}

/**
 * The hand-off worker's gate: canonical Submit from the captured source, rerun on an infrastructure failure, with its
 * green result. Its stages (preflight, cells, doctrine, static, tests) are Submit's own; a refusal throws.
 * Why: an infrastructure failure reruns the same candidate; only a test or check failure is a red for the builder (#2516).
 *
 * @param {any} ctx - The worker's context, bound to the native job.
 * @param {{ item: number, infra?: string }} request
 * @param {{ waitInventory: (commit: string) => Promise<unknown>, submit?: typeof submitHere }} options
 */
export async function handoffGate(ctx, request, { waitInventory, submit = submitHere }) {
  ctx.submissionResult = {};
  const { lockWaits } = await submitUntilSettled(() => submit(ctx, request.item, request.infra), { say: line => process.stderr.write(line + '\n'), waitInventory });
  return handoffGreenResult(ctx, lockWaits);
}

/**
 * The hand-off worker's gate as a drive-cell gate: driveOnce's `{ gate }` option. It runs the same handoffGate, with
 * Submit's stages passed through the driver's observer, and returns the result the worker would record, green or
 * refused, so a gate driven by driveOnce runs the worker's sections in its order and records the same result [C7].
 *
 * @param {any} ctx - The worker's context, bound to the native job.
 * @param {{ item: number, infra?: string }} request
 * @param {{ waitInventory: (commit: string) => Promise<unknown>, submit?: typeof submitHere }} options
 * @returns {(observe: (stages: object[]) => object[]) => Promise<object>}
 */
export function drivenHandoffGate(ctx, request, options) {
  return async observe => {
    ctx.runGateStages = (stages, settings) => runGateStages(observe(stages), settings);
    try { return await handoffGate(ctx, request, options); }
    catch (error) { return handoffRefusedResult(error); }
    finally { delete ctx.runGateStages; }
  };
}

/** How long the gate's driver rests between drives that moved nothing; a whole gate moves on every drive. */
const GATE_DRIVE_POLL_MS = 1000;

/**
 * Run one queued submit gate as a drive-cell job, in this process: the dispatcher admitted it to `owner` and started
 * this process for it. The gate (canonical Submit from the captured source) runs through driveOnce's gate path, its
 * stages written to the drive job as they settle, and its result is recorded on the hand-off once the verdict is
 * written. The drive lease is renewed every 5 s while the gate runs, so a dead driver is known by its row within
 * 2 minutes, never by a worker file [C7].
 *
 * Why one process: the gate's state lives in the job rows, so this process holds nothing a successor needs; the
 * dispatcher starts exactly one per admitted gate, and nothing else is launched for it.
 *
 * @param {string} requestFile - The hand-off's captured request.json.
 * @param {{ nativeBoard: any, owner: string }} options - The board module, and the driver id the dispatcher admitted.
 * @returns {Promise<void>}
 */
export async function driveSubmitHandoff(requestFile, { nativeBoard, owner }) {
  if (typeof owner !== 'string' || !owner) throw new Refused('DRIVE_OWNER', 'a gate driver needs the owner the dispatcher admitted it under');
  const { request, directory, root } = workerRequest(requestFile);
  let ctx;
  let attached = false;
  /** Remove this driver's disposable checkout and its own tool snapshot, once. */
  const cleanup = () => {
    if (!attached) return;
    attached = false;
    try { jobGit(request.commonDir, ['worktree', 'remove', '--force', root]); }
    finally { cleanupToolSnapshot(request); }
  };
  /**
   * A stop signal records the gate's refusal before anything is removed, then stops the gate's own process group,
   * as the supervisor did for its child: the builder reads why the gate ended, never a silent running job.
   */
  const terminate = signal => async () => {
    const failure = { code: 1, ...refusalDocument(new Refused('SUBMIT_HANDOFF_EXIT',
      `queued submit worker exited with code none and signal ${signal} without a terminal result; read its worker.log before resubmitting the captured source`), { caller: 'seat' }) };
    try { await recordWorkerFailure(ctx, request, directory, failure); }
    finally {
      try { cleanup(); } catch { /* the folder sweep removes what a stopped driver could not */ }
      try { process.kill(-process.pid, 'SIGKILL'); } catch { /* not a group leader: only this process stops */ }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  process.once('SIGTERM', terminate('SIGTERM'));
  process.once('SIGINT', terminate('SIGINT'));
  try {
    jobGit(request.commonDir, ['worktree', 'add', '--detach', root, request.commit]);
    attached = true;
    const binding = workerContext(request, directory, root, nativeBoard);
    ctx = binding.ctx;
    const { job } = binding;
    const started = await withBoard(ctx, board => ordered(ctx, board, 'startSubmitHandoff', [request.item, { agentId: job.agentId, job: job.id }]));
    if (!started.started) return;
    ctx.submitHandoffOutput = join(directory, 'output');
    mkdirSync(ctx.submitHandoffOutput, { recursive: true, mode: 0o700 });
    const drive = gateDriveJobId(request.job);
    // The dispatcher admitted the drive job by its place in line; the captured request names what it drives.
    withBoard(ctx, board => {
      createJob(board.db, { id: drive, kind: GATE_DRIVE_KIND, item: request.item, candidate: request.commit });
      nameJob(board.db, drive, { item: request.item, candidate: request.commit });
    });
    const gate = drivenHandoffGate(ctx, request, { waitInventory: commit => inventoryFromJob(nativeBoard, ctx, root, commit, request.job) });
    const board = nativeBoard.openBoard(ctx.file);
    let result;
    try {
      const last = await drainLoop(board.db, drive, { owner, repo: root, gate, intervalMs: GATE_DRIVE_POLL_MS });
      if (last.code) throw new Refused(last.code, `gate ${request.job} is driven by another driver; this driver stops`);
      result = last.job.steps.find(step => step.name === 'collected')?.payload.result;
    } finally { store.closeBoard(board); }
    if (!result) throw new Refused('SUBMIT_HANDOFF_EXIT', `gate ${request.job} reached its verdict with no recorded result`);
    await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [request.item, { agentId: job.agentId, job: job.id, result }]));
    withBoard(ctx, board => finishJob(board.db, drive, owner));
  } catch (error) {
    await recordWorkerFailure(ctx, request, directory, handoffRefusedResult(error));
    throw error;
  } finally {
    // This process created the disposable checkout; generated files must not strand it.
    cleanup();
  }
}
