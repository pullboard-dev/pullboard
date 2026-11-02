import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { refusalDocument } from './next-step-words.js';
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
import { gitSpawnSync } from './git-adapter.js';
import { cleanGitEnvironment } from './git.js';
import {
  context,
  withBoard,
} from './cli-context.js';
import { ordered } from './cli/claim.js';
import {
  bindSubmitHandoffOrigin,
  submitHandoffRoot,
  isSubmitHandoffWorker,
} from './submit-handoff-origin.js';
import { submitHandoff } from './submit-handoff-read.js';
import { submitHere } from './commands/submit.js';
import { Refused } from '../packages/kernel/index.js';

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
  const tools = dirname(dirname(fileURLToPath(import.meta.url)));
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
    await submitHere(ctx, request.item, request.infra);
    await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [request.item,
      { agentId: job.agentId, job: job.id, result: { code: 0, commit: ctx.submissionResult.value?.commit } }]));
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
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), requestFile, '--execute'],
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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const nativeBoard = await import('./native-board.js');
  const run = process.argv[3] === '--execute' ? runSubmitHandoffWorker : superviseSubmitHandoffWorker;
  run(process.argv[2], { nativeBoard, prepared: process.argv[3] === '--execute' }).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
