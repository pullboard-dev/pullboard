import { spawnCaptured } from '../../../../sandbox/light.js';
import { scratchFolder } from '../../../../config/index.js';
import { environmentAdapter } from '../../../../env/index.js';
/**
 * Run one shell command in a checkout and keep its output, apart from the gate's queue, runners and receipts. A
 * board read that replays a check baseline needs only this, so it never loads the gate [C7].
 */
import { spawnSync } from 'node:child_process';
import {
  captureTestRuntimes,
  executionEnvironment,
} from '../../../../sandbox/light.js';
import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  gitChildEnv,
  invalidateGitFacts,
} from '../../../../git/index.js';
import {
  gateStages,
  readPipes,
  readStages,
  stagedScript,
} from '../stages.js';
import { Refused } from '../../../../kernel/index.js';
import { runStallMs } from './stall.js';
import {
  processRows,
  watchRun,
} from './stall.js';
import { sandboxBlockedOperation } from '../../../../sandbox/light.js';

/**
 * Run a shell command in a checkout for a digest: both streams in one pipe, in order, read whole
 * however long, stdin closed so nothing waits on a person. With `stages`, each top-level stage's
 * exit status and own output are kept too, or `stages` is null when the command cannot be split.
 *
 * @param {string} root
 * @param {string} command
 * @param {{ pipefail?: boolean, env?: NodeJS.ProcessEnv, stages?: boolean, timeoutMs?: number, captureRuntimes?: boolean, timedShell?: string, environment?: ReturnType<typeof environmentAdapter> }} [options] - Gate-only pipefail, additional child environment values and per-stage accounting. A run with `timeoutMs` spawns the bounded-shell program at `timedShell`, which its caller names (the app that owns it), so this package names no app path [C7].
 * @returns {{ isGreen: boolean, output: string, seconds: number, sandboxBlocked: string|null, stages?: Array<{ status: number|null, output: string, pipeline?: Array<{ status: number|null, output: string|null }> }> | null }}
 */
function* shellExecution(root, command, { environment = environmentAdapter(), pipefail = false, env = {}, stages = false, timeoutMs, captureRuntimes = false, timedShell = environment.get('PULLBOARD_TIMED_SHELL') } = {}) {
  const landingCustody = environment.get('PULLBOARD_LANDING_CUSTODY');
  const started = Date.now();
  const diagnostics = [];
  const options = { cwd: root, env: gitChildEnv(root, { env, report: diagnostics.push.bind(diagnostics) }), shell: true,
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 2 ** 30 };
  let prefix = '';
  if (pipefail) {
    // Probe the same shell as the command, with no load-sensitive deadline or alternate shell.
    const probe = yield { command: 'set -o pipefail', args: [], options };
    if (probe.status === 0) prefix = 'set -o pipefail\n';
    else if (hasPipeline(command)) {
      throw new Refused('PIPEFAIL_UNAVAILABLE', 'the repo gate shell cannot enable pipefail; rewrite the gate without a pipe');
    }
  }
  // Read-only baselines and caller-output profiles have no proof receipt to bind.
  // Leave their execution environment unchanged; only admitted proof runs collect children.
  const callerEnv = options.env;
  const runtimes = captureRuntimes ? captureTestRuntimes(options.env) : null;
  if (runtimes) options.env = runtimes.env;
  try {
    const split = stages ? gateStages(command) : null;
    const marker = `PULLBOARD_STAGE_${randomUUID().replaceAll('-', '')}`;
    const pipes = split?.some((stage) => stage.pipeline.length > 1) ? scratchFolder('pullboard-pipes-') : null;
    // A landing's guardian finds its gate by this token in the shell's command line [Q1,Q3,B3].
    const custody = landingCustody ? `: --landing-custody=${landingCustody}\n` : '';
    // Newlines, not spaces, around the command, so a trailing comment in it cannot swallow the `)`.
    const script = `${custody}${prefix}(\n${split ? stagedScript(split, marker, pipes) : command}\n) 2>&1`;
    const timedDirectory = timeoutMs ? scratchFolder('pullboard-timed-output-') : null;
    const outputFile = timedDirectory ? join(timedDirectory, 'output.log') : null;
    if (timeoutMs && !timedShell) throw new Refused('TIMED_SHELL_MISSING', 'a run with a timeout needs the timed shell entry from its caller (options.timedShell or PULLBOARD_TIMED_SHELL); pass it from the app that owns the shell');
    const timed = timeoutMs ? yield { command: process.execPath, args: [timedShell, ...(landingCustody ? [`--landing-custody=${landingCustody}`] : [])], options: { ...options, env: { ...callerEnv, ...(runtimes ? { PULLBOARD_RUNTIME_CAPTURE_DIR: runtimes.env.PULLBOARD_RUNTIME_CAPTURE_DIR } : {}) }, shell: false, stdio: ['pipe', 'pipe', 'pipe'], input: JSON.stringify({ command: script, timeoutMs, outputFile }) } } : null;
    if (timed && (timed.status !== 0 || timed.error)) throw new Refused('LAND_TIMEOUT_CUSTODY', 'the timed gate worker did not prove cleanup; inspect its owned processes before landing again');
    const result = timed ? { ...JSON.parse(timed.stdout || '{}'), stdout: '', stderr: timed.stderr } : yield { command: script, args: [], options };
    if (timed && result.error) throw new Refused('LAND_GATE_OUTPUT', `the timed gate stopped and drained after its output failed (${result.error}); inspect free disk space and ${timedDirectory} before landing again`);
    if (timed) result.stdout = readFileSync(outputFile, 'utf8') + (result.timedOut ? `\n[LAND_GATE_TIMEOUT] landing gate exceeded ${timeoutMs}ms; its owned processes are stopped\n` : '');
    if (timedDirectory) rmSync(timedDirectory, { recursive: true, force: true });
    if (result.timedOut || result.overflow || result.error) result.status = 1;
    invalidateGitFacts();
    const pipeStatuses = pipes ? readPipes(split, pipes) : null;
    if (pipes) rmSync(pipes, { recursive: true, force: true });
    const testRuntimes = runtimes?.finish() ?? null;
    const environment = executionEnvironment();
    const raw = `${diagnostics.join('')}${result.stdout ?? ''}${result.stderr ?? ''}`;
    const seconds = Math.round((Date.now() - started) / 1000);
    const blocked = (output) => (result.status === 0 ? null : sandboxBlockedOperation(root, output));
    if (!stages) return { isGreen: result.status === 0, exitCode: result.status, output: raw, seconds, environment, testRuntimes, ...(timed ? { timedOut: result.timedOut } : {}), sandboxBlocked: blocked(raw) };
    if (!split) return { isGreen: result.status === 0, exitCode: result.status, output: raw, seconds, environment, testRuntimes, ...(timed ? { timedOut: result.timedOut } : {}), stages: null, sandboxBlocked: blocked(raw) };
    const staged = readStages(raw, marker, split.length);
    // Each pipeline component's own status rides on its stage, so no failing producer hides behind a later one.
    const withPipes = staged.stages.map((stage, index) => (pipeStatuses?.[index] ? { ...stage, pipeline: pipeStatuses[index] } : stage));
    return { isGreen: result.status === 0, exitCode: result.status, seconds, environment, testRuntimes, ...(timed ? { timedOut: result.timedOut } : {}), ...staged, stages: withPipes, sandboxBlocked: blocked(staged.output) };
  } finally { runtimes?.finish(); }
}

/** Preserve the synchronous API for existing baseline and landing callers. */
export function runShell(root, command, options) {
  const execution = shellExecution(root, command, options);
  try {
    let step = execution.next();
    while (!step.done) step = execution.next(spawnSync(step.value.command, step.value.args, step.value.options));
    return step.value;
  } finally { execution.return(); }
}

/**
 * Execute the same shell plan without blocking other admitted checks. A run with no hard timeout that makes no output,
 * CPU or process change for the stall interval (options.stallMs, PULLBOARD_RUN_STALL_MS, 15 min) is stopped, named
 * PULLBOARD_RUN_STALLED and ends red, so it frees its slot instead of holding it forever.
 */
export async function runShellAsync(root, command, options) {
  const stallMs = options?.timeoutMs ? 0 : runStallMs(options?.stallMs);
  const execution = shellExecution(root, command, options);
  try {
    let step = execution.next();
    while (!step.done) {
      const guard = new AbortController();
      let stalled = null;
      const watch = watchRun({ stallMs, rows: () => processRows(spawnCaptured), onStall: info => { stalled = info; guard.abort(); } });
      const signal = options?.signal ? AbortSignal.any([options.signal, guard.signal]) : guard.signal;
      let result;
      try { result = await spawnCaptured(step.value.command, step.value.args, { ...step.value.options, signal, onSpawn: watch.spawned, onOutput: watch.output }); }
      catch (error) { if (!stalled) throw error; result = { status: null, stdout: '', stderr: '' }; } finally { watch.stop(); }
      if (stalled) {
        result = { ...result, status: 1, stdout: `${result.stdout ?? ''}\nPULLBOARD_RUN_STALLED: no output and no CPU or process change for ${Math.round(stalled.idleMs / 1000)}s; stopped: ${stalled.processes}\n` };
      }
      step = execution.next(result);
    }
    return step.value;
  } finally { execution.return(); }
}

/** Conservatively detect a pipe when the configured gate shell cannot enforce every stage's status. */
function hasPipeline(command) {
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === '|' && command[index + 1] !== '|' && command[index - 1] !== '|') return true;
  }
  return false;
}
