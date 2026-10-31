import { refusalDocument } from './next-step-words.js';
/** A detached continuation runs canonical Submit from its captured private source, never the builder checkout. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { Refused } from './refused.js';

/** Keep Git operations on the native common repository even if the builder removes its checkout. */
function jobGit(commonDir, args) {
  const result = gitSpawnSync(['--git-dir', commonDir, ...args], { env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Refused('SUBMIT_HANDOFF_SOURCE', `queued source Git ${args[0]} failed: ${String(result.stderr ?? '').slice(0, 1000)}`);
  return result.stdout.trim();
}

/** A private request can only continue the exact native job; it supplies no actor or proof authority. */
export async function runSubmitHandoffWorker(requestFile, { nativeBoard }) {
  const request = JSON.parse(readFileSync(requestFile, 'utf8'));
  const directory = dirname(resolve(requestFile));
  const root = join(directory, 'source');
  const io = { cwd: root, nativeBoard, relayJson: true,
    say: line => process.stdout.write(String(line) + '\n'),
    err: line => process.stderr.write(String(line) + '\n'),
    result: value => { writeFileSync(join(directory, 'submission.json'), JSON.stringify(value) + '\n', { mode: 0o600 }); } };
  let ctx;
  let attached = false;
  try {
    if (root !== submitHandoffRoot(request.commonDir, { id: request.job })) throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the request does not name its native job directory');
    // A pending queue pins its source before the builder may move or release Git references.
    jobGit(request.commonDir, ['worktree', 'add', '--detach', root, request.commit]);
    attached = true;
    ctx = context(io);
    const job = withBoard(ctx, board => submitHandoff(board, request.item));
    if (!job || job.id !== request.job) throw new Refused('SUBMIT_HANDOFF_CHANGED', 'the original queued request is no longer current');
    withBoard(ctx, board => bindSubmitHandoffOrigin(ctx, board, request.item, request.job));
    const started = await withBoard(ctx, board => ordered(ctx, board, 'startSubmitHandoff', [request.item, { agentId: job.agentId, job: job.id }]));
    if (!started.started) return;
    ctx.submitHandoffOutput = join(directory, 'output');
    mkdirSync(ctx.submitHandoffOutput, { recursive: true, mode: 0o700 });
    ctx.submissionResult = {};
    await submitHere(ctx, request.item, request.infra);
    await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [request.item,
      { agentId: job.agentId, job: job.id, result: { code: 0, commit: ctx.submissionResult.value?.commit } }]));
  } catch (error) {
    const failure = { code: 1, ...refusalDocument(error, { caller: 'seat' }) };
    writeFileSync(join(directory, 'refusal.json'), JSON.stringify(failure) + '\n', { mode: 0o600 });
    if (ctx && isSubmitHandoffWorker(ctx)) {
      try {
        const job = withBoard(ctx, board => submitHandoff(board, request.item));
        if (job?.id === request.job) await withBoard(ctx, board => ordered(ctx, board, 'completeSubmitHandoff', [request.item,
          { agentId: job.agentId, job: job.id, result: failure, reopenFirstRefusalMinutes: ctx.config.claim?.reopenFirstRefusalMinutes }]));
      } catch (recordingError) { process.stderr.write(`queued result was not recorded: ${recordingError.message}\n`); }
    }
    throw error;
  } finally {
    if (attached) jobGit(request.commonDir, ['worktree', 'remove', root]);
  }
}

/** Expose the real worker module as a declared import dependency of its launcher. */
export function submitHandoffWorkerEntrypoint() { return fileURLToPath(import.meta.url); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const nativeBoard = await import('./native-board.js');
  runSubmitHandoffWorker(process.argv[2], { nativeBoard }).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
