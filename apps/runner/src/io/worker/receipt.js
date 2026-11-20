/** Send the single result receipt and name a refused setup without leaking paths or credentials [C7]. */
import { SPEC_RULES } from '../spec.js';
import { flushStdout } from './command.js';
import { safeGitDiagnostic } from './git.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { executionEnvironment } from '../../../../../packages/sandbox/light.js';
import { availableParallelism } from 'node:os';
import { freemem } from 'node:os';
import { loadavg } from 'node:os';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { readRunnerSigningKey } from '../../../../../packages/runners/light.js';
import { signRunnerReceipt } from '../../../../../packages/runners/light.js';

const RECEIPT = 'PULLBOARD_RUNNER_RESULT';

/** Send the single nonce-bound result line after the complete merged output has drained. */
export async function receipt(spec, fields, sink) {
  await flushStdout();
  const body = { id: spec.id, commit: spec.commit, tree: spec.tree, dependencies: fields.dependencies ?? 'none', code: fields.code, signal: fields.signal,
    environment: executionEnvironment(), testRuntimes: fields.testRuntimes ?? null, gui: fields.gui ?? null, timing: spec.timing === true, executionAdmission: fields.executionAdmission ?? null,
    executionPhases: fields.executionPhases,
    ...(fields.sourcePreparation ? { sourcePreparation: fields.sourcePreparation } : {}),
    runtimeSha256: spec.runtime.sha256, toolingSha256: spec.tooling.sha256, root: fields.root ?? '', outputSha256: sink.hash.digest('hex'), wallMs: Math.max(0, Date.now() - sink.wallStart),
    // The execution host's load and the pinned main this run used, so a paired rerun here can be judged (#925).
    main: typeof spec.main === 'string' ? spec.main : null, load: { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) },
    ...(fields.trustedMode ? { trustedMode: fields.trustedMode } : {}),
    ...(fields.testResults ? { testResults: fields.testResults } : {}),
    ...(fields.handoff ? { handoff: fields.handoff } : {}),
    ...(fields.screenshots?.length ? { screenshots: fields.screenshots } : {}),
    ...(spec.stageMarker ? { pipeStatuses: fields.pipeStatuses ?? null } : {}), ...(fields.timedOut ? { timedOut: true } : {}), ...(fields.refused ? { refused: fields.refused } : {}), ...(fields.browserRefused ? { browserRefused: true } : {}), ...(fields.denial ? { denial: fields.denial } : {}) };
  let completed = body;
  if (spec.runnerPublicKey) {
    const environment = environmentAdapter();
    const configuredHome = environment.get('PULLBOARD_MACHINE_HOME');
    if (configuredHome !== undefined && !isAbsolute(configuredHome)) throw new Error('runner signing home is invalid');
    const signingHome = configuredHome ?? join(isAbsolute(environment.get('HOME', '')) ? environment.get('HOME') : userInfo().homedir, '.pullboard');
    completed = { ...body, signature: signRunnerReceipt(body, readRunnerSigningKey(signingHome, spec.runnerPublicKey)) };
  }
  const encoded = Buffer.from(JSON.stringify(completed)).toString('base64');
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
  const cause = safeGitDiagnostic(S, message, '', { HOME: environmentAdapter().get('HOME'), TMPDIR: environmentAdapter().get('TMPDIR') });
  return `runner setup refused: ${category}; step: ${error?.runnerSetupStep ?? step}${code}\ncause: ${cause || '(unavailable)'}`;
}

/**
 * The fixed rule text of a refused spec, or a generic name when the cause is not one of this runner's own fixed messages.
 * Why: JSON parser and system errors can quote the rejected input, so only the listed rule texts pass.
 */
export function specRefusalRule(error) {
  if (error instanceof SyntaxError) return 'work specification is not valid JSON';
  const message = String(error?.message ?? '');
  return SPEC_RULES.has(message) ? message : 'work specification could not be read';
}

/** Terminate a pre-receipt refusal without waiting for the controller's still-open input stream. */
export function failedWorker(S, error) {
  if (S.workSpecAccepted) { process.exitCode = 1; return; }
  clearInterval(S.heartbeatTimer);
  clearTimeout(S.cleanupTimer);
  clearTimeout(S.phaseCleanupTimer);
  S.rejectPendingFrame = null;
  // Never echo rejected JSON, paths or credentials; this marker is a failure, not an execution receipt.
  process.stderr.write('PULLBOARD_RUNNER_SPEC_REFUSED invalid work specification\n');
  process.stderr.write(`PULLBOARD_RUNNER_SPEC_RULE ${specRefusalRule(error)}\n`);
  if (Number.isSafeInteger(S.workSpecVersion)) process.stderr.write('PULLBOARD_RUNNER_SPEC_VERSION 1\n');
  process.exitCode = 1;
  stopReading();
}
