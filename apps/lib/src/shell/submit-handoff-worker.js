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
import { BUSY_CODES } from './submit-infra-requeue.js';
import { infrastructureFailure } from './submit-infra-requeue.js';
import { submitUntilSettled } from './submit-infra-requeue.js';

/** Retry one native handoff write when board or slot storage is contended, retaining each wait for its receipt. */
export async function retryBusyHandoffWrite(write, { wait = ms => new Promise(done => setTimeout(done, ms)), busyBudgetMs = 2 * 60 * 60 * 1000, busyFirstMs = 5_000 } = {}) {
  const busyWaits = [];
  let spent = 0;
  let streak = 0;
  while (true) {
    try { return { result: await write(), busyWaits }; }
    catch (error) {
      const code = infrastructureFailure(error);
      if (!BUSY_CODES.has(code) || spent >= busyBudgetMs) throw error;
      const ms = Math.min(busyFirstMs * 2 ** streak, 60_000, busyBudgetMs - spent);
      streak += 1;
      spent += ms;
      busyWaits.push({ code, seconds: Math.round(ms / 100) / 10 });
      await wait(ms);
    }
  }
}

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

/** Bind this process to the exact native queue before it can record even a failure. */
function workerContext(request, directory, root, nativeBoard) {
  const ctx = context({ cwd: root, nativeBoard, relayJson: true,
    say: line => process.stdout.write(String(line) + '\n'),
    err: line => process.stderr.write(String(line) + '\n'),
    result: value => { writeFileSync(join(directory, 'submission.json'), JSON.stringify(value) + '\n', { mode: 0o600 }); } });
  const job = withBoard(ctx, board => submitHandoff(board, request.item));
  if (!job || job.id !== request.job) throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the original queued request is no longer current');
  withBoard(ctx, board => bindSubmitHandoffOrigin(ctx, board, request.item, request.job));
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

/** Remove only the executing job's own temporary tool snapshot, including aliased temporary roots. */
function cleanupToolSnapshot(request) {
  const tools = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
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
  const busyWaits = [];
  try {
    if (!prepared) {
      jobGit(request.commonDir, ['worktree', 'add', '--detach', root, request.commit]);
      attached = true;
    }
    const binding = workerContext(request, directory, root, nativeBoard);
    ctx = binding.ctx;
    const { job } = binding;
    const start = await retryBusyHandoffWrite(() => withBoard(ctx, board => ordered(ctx, board, 'startSubmitHandoff', [request.item, { agentId: job.agentId, job: job.id }])), { busyBudgetMs: job.leaseMs });
    busyWaits.push(...start.busyWaits);
    const started = start.result;
    if (!started.started) return;
    ctx.submitHandoffOutput = join(directory, 'output');
    mkdirSync(ctx.submitHandoffOutput, { recursive: true, mode: 0o700 });
    ctx.submissionResult = {};
    // An infrastructure failure reruns the same candidate; only a test or check failure is a red for the builder (#2516).
    const settled = await submitUntilSettled(() => submitHere(ctx, request.item, request.infra), { say: line => process.stderr.write(line + '\n'), busyBudgetMs: job.leaseMs });
    busyWaits.push(...settled.busyWaits);
    const completed = await retryBusyHandoffWrite(() => withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [request.item,
      { agentId: job.agentId, job: job.id, result: { code: 0, commit: ctx.submissionResult.value?.commit } }])), { busyBudgetMs: job.leaseMs });
    busyWaits.push(...completed.busyWaits);
    // The receipt records each busy code and wait beside the submission it delayed.
    writeFileSync(join(directory, 'busy-waits.json'), JSON.stringify(busyWaits) + '\n', { mode: 0o600 });
  } catch (error) {
    // Preserve contention evidence even when the handoff ultimately returns a refusal.
    writeFileSync(join(directory, 'busy-waits.json'), JSON.stringify(busyWaits) + '\n', { mode: 0o600 });
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
