/**
 * Run one shell command in a checkout and keep its output, apart from the gate's queue, runners and receipts. A
 * board read that replays a check baseline needs only this, so it never loads the gate [C7].
 */
import { spawnSync } from 'node:child_process';
import {
  captureTestRuntimes,
  executionEnvironment,
} from './execution-environment.js';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gitChildEnv,
  invalidateGitFacts,
} from './git.js';
import {
  gateStages,
  readPipes,
  readStages,
  stagedScript,
} from './gate-stages.js';
import { Refused } from './refused.js';
import { sandboxBlockedOperation } from './sandbox-denial.js';

/**
 * Run a shell command in a checkout for a digest: both streams in one pipe, in order, read whole
 * however long, stdin closed so nothing waits on a person. With `stages`, each top-level stage's
 * exit status and own output are kept too, or `stages` is null when the command cannot be split.
 *
 * @param {string} root
 * @param {string} command
 * @param {{ pipefail?: boolean, env?: NodeJS.ProcessEnv, stages?: boolean, timeoutMs?: number, captureRuntimes?: boolean }} [options] - Gate-only pipefail, additional child environment values and per-stage accounting.
 * @returns {{ isGreen: boolean, output: string, seconds: number, sandboxBlocked: string|null, stages?: Array<{ status: number|null, output: string, pipeline?: Array<{ status: number|null, output: string|null }> }> | null }}
 */
export function runShell(root, command, { pipefail = false, env = {}, stages = false, timeoutMs, captureRuntimes = false } = {}) {
  const started = Date.now();
  const options = { cwd: root, env: { ...gitChildEnv(root), ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 2 ** 30 };
  let prefix = '';
  if (pipefail) {
    // Probe the same shell as the command, with no load-sensitive deadline or alternate shell.
    const probe = spawnSync('set -o pipefail', options);
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
    const pipes = split?.some((stage) => stage.pipeline.length > 1) ? mkdtempSync(join(tmpdir(), 'pullboard-pipes-')) : null;
    // Newlines, not spaces, around the command, so a trailing comment in it cannot swallow the `)`.
    const script = `${prefix}(\n${split ? stagedScript(split, marker, pipes) : command}\n) 2>&1`;
    const timedDirectory = timeoutMs ? mkdtempSync(join(tmpdir(), 'pullboard-timed-output-')) : null;
    const outputFile = timedDirectory ? join(timedDirectory, 'output.log') : null;
    const timed = timeoutMs ? spawnSync(process.execPath, [fileURLToPath(new URL('./timed-shell-worker.js', import.meta.url))], { ...options, env: { ...callerEnv, ...(runtimes ? { PULLBOARD_RUNTIME_CAPTURE_DIR: runtimes.env.PULLBOARD_RUNTIME_CAPTURE_DIR } : {}) }, shell: false, stdio: ['pipe', 'pipe', 'pipe'], input: JSON.stringify({ command: script, timeoutMs, outputFile }) }) : null;
    if (timed && (timed.status !== 0 || timed.error)) throw new Refused('LAND_TIMEOUT_CUSTODY', 'the timed gate worker did not prove cleanup; inspect its owned processes before landing again');
    const result = timed ? { ...JSON.parse(timed.stdout || '{}'), stdout: '', stderr: timed.stderr } : spawnSync(script, options);
    if (timed && result.error) throw new Refused('LAND_GATE_OUTPUT', `the timed gate stopped and drained after its output failed (${result.error}); inspect free disk space and ${timedDirectory} before landing again`);
    if (timed) result.stdout = readFileSync(outputFile, 'utf8') + (result.timedOut ? `\n[LAND_GATE_TIMEOUT] landing gate exceeded ${timeoutMs}ms; its owned processes are stopped\n` : '');
    if (timedDirectory) rmSync(timedDirectory, { recursive: true, force: true });
    if (result.timedOut || result.overflow || result.error) result.status = 1;
    invalidateGitFacts();
    const pipeStatuses = pipes ? readPipes(split, pipes) : null;
    if (pipes) rmSync(pipes, { recursive: true, force: true });
    const testRuntimes = runtimes?.finish() ?? null;
    const environment = executionEnvironment();
    const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`;
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

/** Conservatively detect a pipe when the configured gate shell cannot enforce every stage's status. */
function hasPipeline(command) {
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === '|' && command[index + 1] !== '|' && command[index - 1] !== '|') return true;
  }
  return false;
}
