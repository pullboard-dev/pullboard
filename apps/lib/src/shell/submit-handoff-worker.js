import { once } from 'node:events';
import { spawn } from 'node:child_process';
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
import { acceptedCellsFromJob } from './main-audit-produce.js';
import { submitUntilSettled } from './submit-infra-requeue.js';

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
    const { lockWaits } = await submitUntilSettled(() => submitHere(ctx, request.item, request.infra), { say: line => process.stderr.write(line + '\n'),
      waitInventory: commit => inventoryFromJob(nativeBoard, ctx, root, commit, request.job),
      onInfrastructure: rerun => withBoard(ctx, board => ordered(ctx, board, 'appendFact', [request.item, { agentId: job.agentId, kind: 'note',
        text: `Queued gate infrastructure rerun [${rerun.code}] after attempt ${rerun.attempt}${rerun.hosts.length ? ` on ${rerun.hosts.join(', ')}` : ''}: ${rerun.message}` }]))
        .catch(error => process.stderr.write(`infrastructure rerun not recorded: ${error.message}\n`)) });
    await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [request.item,
      { agentId: job.agentId, job: job.id, result: { code: 0, commit: ctx.submissionResult.value?.commit, ...(lockWaits.count ? { lockWaits } : {}), ...(ctx.submissionResult.value?.waitingOwner ? { ownershipWait: ctx.submissionResult.value.waitingOwner.key } : {}) } }]));
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

/** Forward cancellation to the owned child and await its exit before removing its source. */
async function workerExit(child) {
  /** Preserve interrupted status while allowing the supervisor to retain the native refusal and cleanup. */
  const interrupt = () => { process.exitCode = 130; child.kill('SIGINT'); };
  /** Keep termination finite to this child, never a machine-wide process search. */
  const terminate = () => { process.exitCode = 143; child.kill('SIGTERM'); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try { return await once(child, 'close'); }
  finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

/** Supervise a real child while retaining only finite refusal authority for its captured native job. */
export async function superviseSubmitHandoffWorker(requestFile, { nativeBoard }) {
  const { request, directory, root } = workerRequest(requestFile);
  let ctx;
  let attached = false;
  try {
    jobGit(request.commonDir, ['worktree', 'add', '--detach', root, request.commit]);
    attached = true;
    ctx = workerContext(request, directory, root, nativeBoard).ctx;
    const child = spawn(process.execPath, [realpathSync(fileURLToPath(import.meta.url)), requestFile, '--execute'],
      { cwd: root, stdio: 'inherit', env: { ...process.env } });
    const [code, signal] = await workerExit(child);
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
