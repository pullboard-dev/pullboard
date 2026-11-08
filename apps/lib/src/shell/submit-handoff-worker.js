import { refusalDocument } from '../../../../src/next-step-words.js';
/** A gate's driver runs canonical Submit from its captured private source, never the builder checkout [C7]. */
import {
  existsSync,
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
import { releaseLease } from '../../../../packages/jobs/index.js';
import { borrowGateCheckout } from './gate-checkout-pool.js';
import { discardGateCheckout } from './gate-checkout-pool.js';
import { returnGateCheckout } from './gate-checkout-pool.js';
import { gateCheckoutPool } from './gate-checkout-pool.js';

/** Git for the gate's kept checkouts, without the caller's Git environment; a failure is returned, never thrown. */
function gateGit(args) {
  const result = gitSpawnSync(args, { env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return { ok: result.status === 0, out: String(result.stdout ?? '').trim(), err: String(result.stderr ?? '') };
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
          { agentId: job.agentId, job: job.id, result: failure, reopenFirstRefusalMinutes: ctx.config.claim?.reopenFirstRefusalMinutes,
            ...(ctx.config.claim?.returnToBoard === true ? { returnToBoard: true } : {}) }]));
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
 * `healthy` and `wait` replace the rerun's runner probe and pause, as submitUntilSettled takes them; a fixture passes them.
 *
 * @param {{ waitInventory: (commit: string) => Promise<unknown>, submit?: typeof submitHere, healthy?: () => Promise<boolean>, wait?: (ms: number) => Promise<void> }} options
 */
export async function handoffGate(ctx, request, { waitInventory, submit = submitHere, healthy, wait }) {
  ctx.submissionResult = {};
  const { lockWaits } = await submitUntilSettled(() => submit(ctx, request.item, request.infra), { say: line => process.stderr.write(line + '\n'), waitInventory,
    ...(healthy ? { healthy } : {}), ...(wait ? { wait } : {}) });
  return handoffGreenResult(ctx, lockWaits);
}

/**
 * The hand-off worker's gate as a drive-cell gate: driveOnce's `{ gate }` option. It runs the same handoffGate, with
 * Submit's stages passed through the driver's observer, and returns the result the worker would record, green or
 * refused, so a gate driven by driveOnce runs the worker's sections in its order and records the same result [C7].
 *
 * With `stop`, a stopped driver's gate never settles: its stages are stopped through their own signals and nothing
 * more is written to the drive job, which stays resumable at its last saved step. The drive cell's `run.signal` ends
 * one run the same way when it stalls, so that run starts no new stage and no rerun while the cell reruns the same
 * candidate (#3661).
 *
 * @param {any} ctx - The worker's context, bound to the native job.
 * @param {{ item: number, infra?: string }} request
 * @param {{ waitInventory: (commit: string) => Promise<unknown>, submit?: typeof submitHere, stop?: AbortSignal, inflight?: Set<Promise<unknown>>,
 *   healthy?: () => Promise<boolean>, wait?: (ms: number) => Promise<void> }} options
 * @returns {(observe: (stages: object[]) => object[], run?: { signal?: AbortSignal }) => Promise<object>}
 */
export function drivenHandoffGate(ctx, request, { stop, inflight = new Set(), ...options }) {
  return async (observe, { signal: ended } = {}) => {
    const halt = stop && ended ? AbortSignal.any([stop, ended]) : stop ?? ended;
    const runStages = (stages, settings) => runGateStages(observe(halt ? stoppableStages(stages, halt, inflight) : stages), settings);
    ctx.runGateStages = runStages;
    try { return await handoffGate(ctx, request, options); }
    catch (error) {
      if (halt?.aborted) return new Promise(() => {});
      return handoffRefusedResult(error);
    }
    // A stalled run that settles late must not remove the observer of the run that replaced it.
    finally { if (ctx.runGateStages === runStages) delete ctx.runGateStages; }
  };
}

/**
 * Wrap a gate's stages so a driver stop reaches each running stage through its own signal: the check and proof run
 * as asynchronous child processes, and their signal stops each child's process group. Each running stage is kept in
 * `inflight` until it settles, so the driver can wait for its children to close before it exits. Once stopped, a
 * stage neither starts nor settles, so no outcome of a stopped run is written as the gate's [C7].
 *
 * Why: no process is load-bearing; a stopped driver leaves its job at its last saved step for the next driver.
 *
 * @param {{ name: string, run: (signal: AbortSignal) => unknown }[]} stages
 * @param {AbortSignal} stop - Aborted when the driver is told to stop.
 * @param {Set<Promise<unknown>>} inflight - The stages still running, filled and emptied in place.
 * @returns {{ name: string, run: (signal: AbortSignal) => Promise<unknown> }[]}
 */
export function stoppableStages(stages, stop, inflight) {
  return stages.map(stage => ({ ...stage, run: async signal => {
    if (stop.aborted) return new Promise(() => {});
    const running = Promise.resolve().then(() => stage.run(AbortSignal.any([signal, stop])));
    inflight.add(running);
    try { return await running; }
    catch (error) {
      if (stop.aborted) return new Promise(() => {});
      throw error;
    } finally { inflight.delete(running); }
  } }));
}

/** How long the gate's driver rests between drives that moved nothing; a whole gate moves on every drive. */
const GATE_DRIVE_POLL_MS = 1000;

/**
 * How long a stopped driver waits for its stages' child processes to close before it exits anyway. A cancelled
 * child gets SIGTERM and, 500 ms later, SIGKILL (spawnCaptured), so its stage settles well inside this.
 */
const DRIVER_STOP_GRACE_MS = 10_000;

/**
 * Wait until every promise in `running` settles, or `ms` passes, whichever is first.
 *
 * @param {Set<Promise<unknown>>} running
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function settledWithin(running, ms) {
  let timer;
  const bound = new Promise(resolvePromise => { timer = setTimeout(resolvePromise, ms); timer.unref?.(); });
  try { await Promise.race([Promise.allSettled([...running]), bound]); }
  finally { clearTimeout(timer); }
}

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
 * @returns {Promise<{ stalled?: boolean, stopped?: boolean } | undefined>} `stopped` when a stop signal ended the driver,
 *   whose handler frees the lease and exits the process; otherwise the result is recorded (`stalled` when a stalled run
 *   was ended on the way) and the entry ends the process, so a leaked handle never holds its slot (#3108, #3661).
 */
export async function driveSubmitHandoff(requestFile, { nativeBoard, owner }) {
  if (typeof owner !== 'string' || !owner) throw new Refused('DRIVE_OWNER', 'a gate driver needs the owner the dispatcher admitted it under');
  const { request, directory, root } = workerRequest(requestFile);
  let ctx;
  let attached = false;
  const drive = gateDriveJobId(request.job);
  const stopper = new AbortController();
  const inflight = new Set();
  /** Discard this driver's checkout, once; a stopped driver keeps the tool snapshot its successor runs. */
  const removeCheckout = () => {
    if (!attached) return;
    attached = false;
    discardGateCheckout(gateGit, request.commonDir, root);
  };
  /**
   * Give this driver's checkout back to the kept checkouts and remove its own tool snapshot, once the gate has ended.
   * Only an exactly clean checkout at the candidate is kept; a dirty or broken one is discarded (#3700).
   */
  const cleanup = () => {
    const owned = attached;
    attached = false;
    try { if (owned) returnGateCheckout({ git: gateGit, commonDir: request.commonDir, pool: gateCheckoutPool(root), root, commit: request.commit }); }
    finally { if (owned) cleanupToolSnapshot(request); }
  };
  /**
   * A stop signal stops the gate's child processes through their own signals and waits for them to close, then frees
   * the drive lease and exits without a result: the job stays at its last saved step, so the next driver admitted to
   * it resumes it, and the builder never reads a stopped process as a red [C7].
   * Why: no process is load-bearing; the job rows, not this process, hold the gate's state.
   */
  const terminate = signal => async () => {
    stopper.abort(new Refused('SUBMIT_HANDOFF_STOPPED', `the gate driver received ${signal}; the next driver resumes its job`));
    try {
      await settledWithin(inflight, DRIVER_STOP_GRACE_MS);
      if (ctx) withBoard(ctx, board => releaseLease(board.db, drive, owner));
    } catch (error) { process.stderr.write(`stopped gate driver could not free its lease: ${error.message}\n`); }
    finally {
      try { removeCheckout(); } catch { /* the next driver replaces a checkout a stopped driver could not remove */ }
      try { process.kill(-process.pid, 'SIGKILL'); } catch { /* not a group leader: only this process stops */ }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  process.once('SIGTERM', terminate('SIGTERM'));
  process.once('SIGINT', terminate('SIGINT'));
  let stalled = false;
  try {
    // A killed driver can leave this job's own checkout behind in an unknown state; the admitted driver discards it.
    if (existsSync(root)) discardGateCheckout(gateGit, request.commonDir, root);
    // A kept checkout moved to the candidate writes only the files that differ, not the whole tree per gate (#3700).
    let checkout;
    try { checkout = borrowGateCheckout({ git: gateGit, commonDir: request.commonDir, pool: gateCheckoutPool(root), root, commit: request.commit }); }
    catch (error) { throw new Refused('SUBMIT_HANDOFF_SOURCE', error.message); }
    attached = true;
    process.stderr.write(`PULLBOARD_GATE_CHECKOUT ${JSON.stringify(checkout)}\n`);
    const binding = workerContext(request, directory, root, nativeBoard);
    ctx = binding.ctx;
    const { job } = binding;
    const started = await withBoard(ctx, board => ordered(ctx, board, 'startSubmitHandoff', [request.item, { agentId: job.agentId, job: job.id }]));
    // A running job whose driver stopped is resumed by the driver admitted after it, from its last saved step.
    if (!started.started && started.job?.state !== 'running') return;
    ctx.submitHandoffOutput = join(directory, 'output');
    mkdirSync(ctx.submitHandoffOutput, { recursive: true, mode: 0o700 });
    // The dispatcher admitted the drive job by its place in line; the captured request names what it drives.
    withBoard(ctx, board => {
      createJob(board.db, { id: drive, kind: GATE_DRIVE_KIND, item: request.item, candidate: request.commit });
      nameJob(board.db, drive, { item: request.item, candidate: request.commit });
    });
    const gate = drivenHandoffGate(ctx, request, { waitInventory: commit => inventoryFromJob(nativeBoard, ctx, root, commit, request.job),
      stop: stopper.signal, inflight });
    const board = nativeBoard.openBoard(ctx.file);
    let result;
    try {
      // A run with no step for 20 minutes is ended and rerun once by the drive cell, then recorded as this refusal (#3661).
      const last = await drainLoop(board.db, drive, { owner, repo: root, gate, intervalMs: GATE_DRIVE_POLL_MS, stalled: handoffRefusedResult });
      if (last.code) throw new Refused(last.code, `gate ${request.job} is driven by another driver; this driver stops`);
      result = last.job.steps.find(step => step.name === 'collected')?.payload.result;
      stalled = last.job.steps.some(step => step.name === 'gate.stalled');
    } finally { store.closeBoard(board); }
    if (!result) throw new Refused('SUBMIT_HANDOFF_EXIT', `gate ${request.job} reached its verdict with no recorded result`);
    // A refused gate keeps its refusal.json beside the hand-off and records through the same move the worker used
    // for a thrown refusal, so the builder reads the exact canonical refusal (#2516).
    if (result.code !== 0) await recordWorkerFailure(ctx, request, directory, result);
    else await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [request.item, { agentId: job.agentId, job: job.id, result }]));
    withBoard(ctx, board => finishJob(board.db, drive, owner));
    return { stalled };
  } catch (error) {
    // A stopped driver records nothing: its job stays resumable, and the stop handler ends this process.
    if (stopper.signal.aborted) return { stopped: true };
    await recordWorkerFailure(ctx, request, directory, handoffRefusedResult(error));
    throw error;
  } finally {
    // This process created the disposable checkout; generated files must not strand it.
    if (!stopper.signal.aborted) cleanup();
  }
  return stopper.signal.aborted ? 'stopped' : 'settled';
}
