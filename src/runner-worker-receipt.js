/** Send the single result receipt and name a refused setup without leaking paths or credentials [C7]. */
import { flushStdout } from './runner-worker-command.js';
import { safeGitDiagnostic } from './runner-worker-git.js';
import { executionEnvironment } from './execution-environment.js';
import { availableParallelism } from 'node:os';
import { freemem } from 'node:os';
import { loadavg } from 'node:os';

const RECEIPT = 'PULLBOARD_RUNNER_RESULT';

/** Send the single nonce-bound result line after the complete merged output has drained. */
export async function receipt(spec, fields, sink) {
  await flushStdout();
  const body = { id: spec.id, commit: spec.commit, tree: spec.tree, code: fields.code, signal: fields.signal,
    environment: executionEnvironment(), testRuntimes: fields.testRuntimes ?? null, gui: fields.gui ?? null, timing: spec.timing === true, executionAdmission: fields.executionAdmission ?? null,
    executionPhases: fields.executionPhases,
    ...(fields.sourcePreparation ? { sourcePreparation: fields.sourcePreparation } : {}),
    runtimeSha256: spec.runtime.sha256, toolingSha256: spec.tooling.sha256, root: fields.root ?? '', outputSha256: sink.hash.digest('hex'), wallMs: Math.max(0, Date.now() - sink.wallStart),
    // The execution host's load and the pinned main this run used, so a paired rerun here can be judged (#925).
    main: typeof spec.main === 'string' ? spec.main : null, load: { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) },
    ...(fields.trustedMode ? { trustedMode: fields.trustedMode } : {}),
    ...(fields.testResults ? { testResults: fields.testResults } : {}),
    ...(spec.stageMarker ? { pipeStatuses: fields.pipeStatuses ?? null } : {}), ...(fields.timedOut ? { timedOut: true } : {}), ...(fields.refused ? { refused: fields.refused } : {}), ...(fields.browserRefused ? { browserRefused: true } : {}), ...(fields.denial ? { denial: fields.denial } : {}) };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
  await new Promise((resolveWrite, rejectWrite) => process.stderr.write(`${RECEIPT} ${spec.id} ${encoded}\n`, error => error ? rejectWrite(error) : resolveWrite()));
}

/**
 * Name the rule when the runner's own resource API refused setup. The code is a fixed identifier,
 * so it can travel to the controller where paths and runner state cannot.
 */
export function setupRefusalCode(error) {
  return error?.name === 'Refused' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(String(error.code ?? '')) ? error.code : '';
}

/**
 * End this worker's read of the controller's stream once nothing more will be read from it.
 * Only the history pack drains stdin to its end; a run that stops before the pack would otherwise
 * keep the worker, and so the SSH session and the run, alive after its receipt.
 */
export function stopReading() {
  process.stdin.destroy();
}

/** Name a setup phase and bounded cause while hiding private paths and credentials. */
export function safeSetupMessage(S, error, step) {
  if (error?.runnerSetup) {
    const detail = error.runnerSetup;
    return `runner setup refused: ${detail.step} failed (${detail.status})\ngit stderr: ${detail.stderr || '(none)'}`;
  }
  const message = String(error?.message ?? '');
  const category = message.includes('npm') || message.includes('dependency') ? 'committed dependencies are unavailable'
    : message.includes('capacity') || message.includes('queue') ? 'remote capacity is unavailable' : 'source checkout could not be prepared';
  const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(error?.code ?? '') ? ` (${error.code})` : '';
  const cause = safeGitDiagnostic(S, message, '', { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR });
  return `runner setup refused: ${category}; step: ${error?.runnerSetupStep ?? step}${code}\ncause: ${cause || '(unavailable)'}`;
}

/** Terminate a pre-receipt refusal without waiting for the controller's still-open input stream. */
export function failedWorker(S) {
  if (S.workSpecAccepted) { process.exitCode = 1; return; }
  clearInterval(S.heartbeatTimer);
  clearTimeout(S.cleanupTimer);
  clearTimeout(S.phaseCleanupTimer);
  S.rejectPendingFrame = null;
  // Never echo rejected JSON, paths or credentials; this marker is a failure, not an execution receipt.
  process.stderr.write('PULLBOARD_RUNNER_SPEC_REFUSED invalid work specification\n');
  process.exitCode = 1;
  stopReading();
}
