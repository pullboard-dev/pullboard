import { once } from 'node:events';
import { constants as osConstants } from 'node:os';
import { refusalDocument } from '../../../../src/next-step-words.js';
/** A detached continuation runs canonical Submit from its captured private source, never the builder checkout. */
import {
  readFileSync,
  existsSync,
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
import { waitForAcceptedCells } from '../../../../packages/gate/index.js';
import { submitUntilSettled } from './submit-infra-requeue.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { shellWord } from '../../../../packages/transport/index.js';
import { spawnDriveWorker } from '../../../../bin/drive-worker.js';

/** How many times a drive worker that died mid-job is started again before the job ends as SUBMIT_HANDOFF_EXIT. */
const DRIVE_RESPAWNS = 3;

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

/** A private request can only continue the exact native job; it supplies no actor or proof authority. */
export async function runSubmitHandoffWorker(requestFile, { nativeBoard, prepared = false }) {
  const { request, directory, root } = workerRequest(requestFile);
  let ctx;
  let attached = false;
  try {
    if (!prepared) {
      jobGit(request.commonDir, ['worktree', 'add', '--detach', root, request.commit]);
      attached = true;
    }
    const binding = workerContext(request, directory, root, nativeBoard);
    ctx = binding.ctx;
    const { job } = binding;
    const started = await withBoard(ctx, board => ordered(ctx, board, 'startSubmitHandoff', [request.item, { agentId: job.agentId, job: job.id }]));
    if (!started.started) return;
    ctx.submitHandoffOutput = join(directory, 'output');
    mkdirSync(ctx.submitHandoffOutput, { recursive: true, mode: 0o700 });
    ctx.submissionResult = {};
    // An infrastructure failure reruns the same candidate; only a test or check failure is a red for the builder (#2516).
    const { lockWaits } = await submitUntilSettled(() => submitHere(ctx, request.item, request.infra), { say: line => process.stderr.write(line + '\n'), waitInventory: commit => waitForAcceptedCells(root, commit, { beat: line => process.stderr.write(line + '\n') }) });
    await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [request.item,
      { agentId: job.agentId, job: job.id, result: { code: 0, commit: ctx.submissionResult.value?.commit, ...(lockWaits.count ? { lockWaits } : {}) } }]));
  } catch (error) {
    // Lock waits ride on the refusal too, so the job shows how long the gate waited on a busy lock (#3087).
    await recordWorkerFailure(ctx, request, directory, { code: 1, ...refusalDocument(error, { caller: 'seat' }), ...(error?.lockWaits ? { lockWaits: error.lockWaits } : {}) });
    throw error;
  } finally {
    // This process created the disposable checkout and its child has closed; generated files must not strand it.
    if (attached) {
      try { jobGit(request.commonDir, ['worktree', 'remove', '--force', root]); }
      finally { cleanupToolSnapshot(request); }
    }
  }
}

/** Whether a process with this pid still exists. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** The pid the gate's `--execute` process wrote for itself, or null before it started. */
function executePid(drive) {
  try { const pid = Number(readFileSync(join(drive.runner.root, 'execute.pid'), 'utf8')); return Number.isSafeInteger(pid) && pid > 1 ? pid : null; }
  catch { return null; }
}

/**
 * The drive job for one hand-off: its id and the options its drive worker child runs with. Its one shard is the
 * captured `--execute` run, started on this machine through the transport's result-file protocol, writing to the
 * same worker.log and recording its own pid so a cancellation reaches exactly it.
 *
 * @param {object} ctx
 * @param {{ job: string, item: number, commit: string }} request
 * @param {string} requestFile
 * @param {string} directory
 * @param {string} root
 */
function handoffDrive(ctx, request, requestFile, directory, root) {
  const runner = { host: 'local', root: join(directory, 'drive') };
  mkdirSync(runner.root, { recursive: true, mode: 0o700 });
  const command = [`cd ${shellWord(root)}`, `printf '%s' "$$" > ${shellWord(join(runner.root, 'execute.pid'))}`,
    `exec ${shellWord(process.execPath)} ${shellWord(realpathSync(fileURLToPath(import.meta.url)))} ${shellWord(requestFile)} --execute >> ${shellWord(join(directory, 'worker.log'))} 2>&1`].join(' && ');
  return { file: ctx.file, job: `handoff-drive-${request.job}`, owner: `handoff-${request.job}`, repo: root, runner, local: true,
    plan: [{ shard: 'submit', command }] };
}

/**
 * Run the hand-off's drive worker child until its drive job reaches the verdict step. A worker that dies before then
 * is started again with the same owner, which renews the lease and continues from the last written step: the gate
 * shard keeps running and is read, never rerun. A SIGINT or SIGTERM to this supervisor reaches the drive worker and
 * the exact `--execute` process, and is awaited until both have closed.
 *
 * @param {object} ctx
 * @param {{ job: string, item: number, commit: string }} request
 * @param {ReturnType<typeof handoffDrive>} drive
 * @param {string} directory
 * @returns {Promise<[number | null, string | null]>} The gate's exit code and signal, as the old child's close gave them.
 */
async function driveExit(ctx, request, drive, directory) {
  withBoard(ctx, board => createJob(board.db, { id: drive.job, kind: 'gate', item: request.item, candidate: request.commit }));
  let child = null;
  let stopped = null;
  /** Stop the drive worker and the gate process, keeping the interrupted status for the native refusal. */
  const stop = (signal, code) => () => {
    stopped = signal; process.exitCode = code;
    child?.kill(signal);
    const pid = executePid(drive);
    if (pid) try { process.kill(pid, signal); } catch { /* the gate process already ended */ }
  };
  const interrupt = stop('SIGINT', 130);
  const terminate = stop('SIGTERM', 143);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    let last = [null, null];
    for (let start = 0; start <= DRIVE_RESPAWNS && !stopped; start += 1) {
      child = spawnDriveWorker(drive, { stdio: ['ignore', 'ignore', 'inherit'] });
      writeFileSync(join(directory, 'drive.json'), JSON.stringify({ version: 1, job: drive.job, pid: child.pid, start }) + '\n', { mode: 0o600 });
      last = await once(child, 'close');
      const collected = withBoard(ctx, board => jobView(board.db, drive.job))?.steps.find(step => step.name === 'collected');
      if (collected) {
        const status = collected.payload.shards.submit.status;
        const signal = status > 128 ? Object.keys(osConstants.signals).find(name => osConstants.signals[name] === status - 128) : undefined;
        return signal ? [null, signal] : [status, null];
      }
    }
    const pid = stopped ? executePid(drive) : null;
    // The cancelled gate process ends before its source is removed, as the old owned child did.
    for (let wait = 0; pid && wait < 600 && alive(pid); wait += 1) await new Promise(done => setTimeout(done, 50));
    return last;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

/**
 * Supervise the hand-off's drive worker child while retaining only finite refusal authority for its captured native job.
 * Why the drive worker: the gate's state lives in its job row, so this supervisor's child can die mid-gate and the
 * next driver continues it (design item 15); the gate itself still runs canonical Submit from the captured source.
 */
export async function superviseSubmitHandoffWorker(requestFile, { nativeBoard }) {
  const { request, directory, root } = workerRequest(requestFile);
  let ctx;
  let attached = false;
  try {
    jobGit(request.commonDir, ['worktree', 'add', '--detach', root, request.commit]);
    attached = true;
    ctx = workerContext(request, directory, root, nativeBoard).ctx;
    // The hand-off worker is the drive worker child: it calls driveOnce until the gate job's verdict step [C7].
    const drive = handoffDrive(ctx, request, requestFile, directory, root);
    const [code, signal] = await driveExit(ctx, request, drive, directory);
    const job = withBoard(ctx, board => submitHandoff(board, request.item));
    if (job?.id !== request.job || !['queued', 'running'].includes(job.state)) return;
    const refused = join(directory, 'refusal.json');
    let failure;
    if (existsSync(refused)) {
      try { failure = JSON.parse(readFileSync(refused, 'utf8')); }
      catch { /* A damaged artifact cannot replace an explicit observed child-exit refusal. */ }
    }
    if (failure?.code !== 1 || !failure.error?.code || typeof failure.error.message !== 'string' || typeof failure.error.next !== 'string') {
      failure = { code: 1, ...refusalDocument(new Refused('SUBMIT_HANDOFF_EXIT',
        `queued submit worker exited with code ${code ?? 'none'}${signal ? ` and signal ${signal}` : ''} without a terminal result; read its worker.log before resubmitting the captured source`), { caller: 'seat' }) };
    }
    await recordWorkerFailure(ctx, request, directory, failure);
  } catch (error) {
    await recordWorkerFailure(ctx, request, directory, { code: 1, ...refusalDocument(error, { caller: 'seat' }) });
    throw error;
  } finally {
    // This process created the disposable checkout and its child has closed; generated files must not strand it.
    if (attached) {
      try { jobGit(request.commonDir, ['worktree', 'remove', '--force', root]); }
      finally { cleanupToolSnapshot(request); }
    }
  }
}

/** Expose the real worker module as a declared import dependency of its launcher. */
export function submitHandoffWorkerEntrypoint() { return fileURLToPath(import.meta.url); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = process.argv[3] === '--execute' ? runSubmitHandoffWorker : superviseSubmitHandoffWorker;
  // The board's module graph reaches this worker through the lib front door; finish evaluating before loading it.
  import('../core/native-board.js').then(nativeBoard => run(process.argv[2], { nativeBoard, prepared: process.argv[3] === '--execute' }))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
