/** Authenticate a runner receipt and its complete output before trusting any remote status [C7]. */
import { environmentProblem } from './config.js';
import { testRuntimeRows } from './execution-environment.js';
import { RunnerDropped } from './gate-policy-load.js';
import { gateStages } from './gate-stages.js';
import { readStages } from './gate-stages.js';
import { secretsIn } from './hooks.js';
import { Refused } from './refused.js';
import { recordRunnerGui } from './resources.js';
import { sourcePreparationFields } from './runner-overhead.js';
import { remoteFileDenial } from './sandbox-denial.js';
import { importTestResults } from './test-result-store.js';
import { runnerPhaseFields } from './timing.js';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

/** Bound diagnostic text, exclude protocol payloads, and suppress any possible credential instead of echoing it. */
function transportText(value) {
  const text = String(value ?? '').split(/\r?\n/u).filter(line => !line.startsWith('PULLBOARD_RUNNER_')).join('\n').slice(-8192);
  return secretsIn(text.split('\n').map((line, index) => ({ path: 'runner transport', line: index + 1, text: line }))).length
    ? '[possible credential redacted]' : text;
}

/** Preserve which transport/protocol check failed without retaining source capsules, credentials or command output. */
export function runnerFailure(request, result, reason) {
  return new RunnerDropped(request.runner.host, { reason: request.admissionDeadlineExceeded ? 'admission-deadline' : reason, request: request.spec?.id ?? null,
    source: request.spec?.commit ?? null, tree: request.spec?.tree ?? null,
    tooling: request.spec?.tooling?.sha256 ?? null, recovery: request.spec?.recovery ?? null, phase: request.phase ?? 'connect',
    command: ['ssh', ...(request.args ?? []).slice(0, -1), '[pinned Pullboard worker]'],
    exitCode: result.status ?? null, signal: result.signal ?? null,
    error: result.error ? { code: result.error.code ?? result.error.name, message: transportText(result.error.message) } : null,
    stderr: transportText(result.stderr), outputBytes: result.rawBytes ?? Buffer.byteLength(result.stdout ?? '') });
}

/** Verify exact source and complete raw output before accepting any remote status. */
export function resultFrom(request, result, { privateCheckPhases }) {
  const output = result.stdout ?? Buffer.alloc(0);
  const lines = String(result.stderr ?? '').split(/\r?\n/u);
  const prefix = `PULLBOARD_RUNNER_RESULT ${request.spec.id} `;
  const receipts = lines.filter(line => line.startsWith(prefix));
  // A spec rejected before admission has no trustworthy job receipt. Preserve its named failure,
  // never manufacture source/proof metadata or treat the refusal as a transport retry.
  if (!result.error && Number.isInteger(result.status) && result.status > 0 && result.status <= 255 && output.length === 0 && receipts.length === 0
      && lines.filter(line => line === 'PULLBOARD_RUNNER_SPEC_REFUSED invalid work specification').length === 1) {
    const refused = new Refused('RUNNER_WORK_SPEC', `runner ${request.runner.host} refused an invalid work specification before execution`);
    refused.runnerAttempt = { host: request.runner.host, exitCode: result.status, output: output.toString('utf8'), reason: 'invalid work specification' };
    throw refused;
  }

  let receipt;
  try {
    if (receipts.length !== 1) throw new Error('missing receipt');
    receipt = JSON.parse(Buffer.from(receipts[0].slice(prefix.length), 'base64').toString('utf8'));
  } catch { throw runnerFailure(request, result, receipts.length === 1 ? 'receipt-json' : 'receipt-count'); }
  if (result.error || result.status !== 0 || receipt.id !== request.spec.id || receipt.commit !== request.spec.commit
    || receipt.tree !== request.spec.tree || receipt.runtimeSha256 !== request.spec.runtime.sha256 || receipt.toolingSha256 !== request.spec.tooling.sha256 || !Number.isInteger(receipt.code) || receipt.code < 0 || receipt.code > 255
    || typeof receipt.root !== 'string' || !Number.isFinite(receipt.wallMs) || receipt.wallMs < 0
    || receipt.outputSha256 !== (request.spec.trustedMode ? result.rawSha256 : createHash('sha256').update(output).digest('hex'))) {
    throw runnerFailure(request, result, result.error ? 'local-transport-error' : result.status !== 0 ? 'ssh-exit' : 'receipt-binding');
  }
  if (receipt.gui !== undefined && ![true, false, null].includes(receipt.gui)) throw runnerFailure(request, result, 'gui-metadata');
  // This field is bound to this exact request and output digest, never read from command text.
  recordRunnerGui(request.runner.host, receipt.gui ?? null);
  if (receipt.refused === 'RUNNER_GUI_SESSION_REQUIRED') {
    if (!request.spec.guiRequired || receipt.gui === true || receipt.code === 0) throw runnerFailure(request, result, 'gui-refusal-binding');
    const refused = new Refused('RUNNER_GUI_SESSION_REQUIRED', `runner ${request.runner.host} has no confirmed GUI session at job start; rerun this GUI-marked file locally or register a logged-in GUI runner`);
    refused.runnerAttempt = { host: request.runner.host, exitCode: receipt.code, output: output.toString('utf8'), gui: receipt.gui ?? null };
    throw refused;
  }
  if (receipt.timedOut !== undefined && (receipt.timedOut !== true || !request.spec.timeoutMs || receipt.code === 0)) throw runnerFailure(request, result, 'timeout-metadata');
  if (receipt.refused !== undefined) {
    if (typeof receipt.refused !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(receipt.refused) || receipt.code === 0) throw runnerFailure(request, result, 'refusal-metadata');
    // The runner answered, so this is a named failure, not a dropped transport to requeue.
    throw new Refused('RUNNER_SETUP_REFUSED', `runner ${request.runner.host} refused this run before it started: [${receipt.refused}] from its own resource pool; run pullboard resources and pullboard settings on ${request.runner.host} to fix that pool, then run again`);
  }
  // The runner classified any file denial against its own checkout; only its evidence is trusted here.
  const sandboxBlocked = receipt.denial === undefined ? null : remoteFileDenial(receipt.denial, request.runner.host);
  if (receipt.denial !== undefined && (!sandboxBlocked || receipt.code === 0)) throw runnerFailure(request, result, 'denial-metadata');
  let staged = null;
  if (request.spec.stageMarker && !receipt.signal) {
    const split = gateStages(request.spec.command);
    if (split) {
      const parsed = readStages(output.toString('utf8'), request.spec.stageMarker, split.length);
      const pipes = receipt.pipeStatuses;
      staged = { ...parsed, stages: parsed.stages.map((stage, index) => split[index].pipeline.length > 1
        ? { ...stage, pipeline: Array.isArray(pipes) && pipes.length === split.length && Array.isArray(pipes[index])
          && pipes[index].length === split[index].pipeline.length && pipes[index].every(entry => entry && (entry.status === null || Number.isInteger(entry.status) && entry.status >= 0 && entry.status <= 255) && (entry.output === null || typeof entry.output === 'string'))
          ? pipes[index] : null } : stage) };
    }
  }
  let privateResult = null;
  if (request.spec.trustedMode) {
    try {
      if (result.rawOutputPath !== request.rawOutputPath || statSync(result.rawOutputPath).size !== result.rawBytes) throw new Error('missing complete private-check capture');
      privateResult = privateCheckPhases(request.spec.trustedMode, receipt.trustedMode, result.rawBytes);
      if ((privateResult.state === 'pass') !== (receipt.code === 0 && !receipt.signal)) throw new Error('inconsistent private-check completion');
    } catch { throw runnerFailure(request, result, 'private-phase-binding'); }
  } else if (receipt.trustedMode !== undefined) throw runnerFailure(request, result, 'unexpected-private-phases');
  const text = staged?.output ?? output.toString('utf8');
  if (receipt.environment !== undefined && environmentProblem(receipt.environment)) throw runnerFailure(request, result, 'environment-metadata');
  if (receipt.executionPhases !== undefined && !runnerPhaseFields(receipt.executionPhases)) throw runnerFailure(request, result, 'phase-metadata');
  if (receipt.sourcePreparation !== undefined && !sourcePreparationFields(receipt.sourcePreparation)) throw runnerFailure(request, result, 'source-preparation-metadata');
  if (receipt.testRuntimes != null && !testRuntimeRows(receipt.testRuntimes)) throw runnerFailure(request, result, 'test-runtime-metadata');
  if (receipt.browserRefused !== undefined && (receipt.browserRefused !== true || receipt.code === 0 || request.spec.browserRequired)) throw runnerFailure(request, result, 'browser-metadata');
  const admission = remoteAdmission(receipt.executionAdmission);
  if (request.spec.timing === true && (receipt.timing !== true || !admission)) throw runnerFailure(request, result, 'timing-admission');
  // Only the lease guard's own receipt counts; text a test prints is never a refusal (#1043).
  if (receipt.browserRefused === true) {
    const refused = new Refused('RUNNER_BROWSER_SLOT_REQUIRED', `runner ${request.runner.host} refused this run's lease for want of a browser slot (BROWSER_SLOT_REQUIRED)`);
    refused.runnerAttempt = { host: request.runner.host, exitCode: receipt.code, output: text };
    throw refused;
  }
  // A cache packet is considered only after the nonce, exact source, complete output and private
  // source guard have authenticated this completion. A dropped run imports no passing receipt.
  if (request.exchange && !receipt.signal && (!privateResult || privateResult.state === 'pass')) {
    importTestResults(request.exchange.store, receipt.testResults, request.spec.testResults.inputKeys);
  }
  return { isGreen: receipt.code === 0 && !receipt.signal, output: text, sandboxBlocked, ...(receipt.timedOut ? { timedOut: true } : {}),
    environment: receipt.environment ?? null, testRuntimes: receipt.testRuntimes ?? null, executionCapabilities: { gui: receipt.gui ?? null },
    ...(request.spec.stageMarker ? { stages: staged?.stages ?? null } : {}),
    seconds: Math.round(receipt.wallMs / 1000), exitCode: receipt.code,
    executionRunner: request.runner.host, executionRoot: receipt.root, remoteWallMs: receipt.wallMs,
    ...(receipt.executionPhases ? { executionPhases: runnerPhaseFields(receipt.executionPhases) } : {}),
    ...(receipt.sourcePreparation ? { sourcePreparation: sourcePreparationFields(receipt.sourcePreparation) } : {}),
    executionSource: { commit: receipt.commit, tree: receipt.tree, tooling: request.spec.tooling },
    ...(privateResult ? { privateCheck: { ...privateResult, receipt: receipt.trustedMode }, rawOutputPath: result.rawOutputPath, rawOutputSha256: result.rawSha256 } : {}),
    executionMain: request.spec.main && receipt.main === request.spec.main ? receipt.main : null, executionLoad: remoteLoad(receipt.load), executionAdmission: admission };
}

/** Validate executor-sampled admission intervals and both load timestamps before trusting timing isolation. */
function remoteAdmission(value) {
  if (!value || !Number.isSafeInteger(value.slots) || value.slots < 1) return null;
  const admitted = Date.parse(value.admittedAt);
  const finished = Date.parse(value.finishedAt);
  const startAt = Date.parse(value.load?.start?.at);
  const endAt = Date.parse(value.load?.end?.at);
  const start = remoteLoad(value.load?.start);
  const end = remoteLoad(value.load?.end);
  if (![admitted, finished, startAt, endAt].every(Number.isFinite) || finished < admitted
    || startAt < admitted || endAt < startAt || finished !== endAt || !start || !end) return null;
  if (typeof value.exclusive !== 'boolean' || !Array.isArray(value.unfencedClients)
    || value.unfencedClients.some(client => !client || typeof client.agent !== 'string'
      || !Number.isSafeInteger(client.pid) || client.pid < 1 || typeof client.started !== 'string')
    || value.exclusive && value.unfencedClients.length > 0) return null;
  return { slots: value.slots, admittedAt: value.admittedAt, finishedAt: value.finishedAt,
    exclusive: value.exclusive, unfencedClients: value.unfencedClients,
    load: { start: { at: value.load.start.at, ...start }, end: { at: value.load.end.at, ...end } } };
}

/** The execution host's load from a receipt, or null when any part of it is missing or malformed (#925). */
function remoteLoad(load) {
  const average = Array.isArray(load?.average) && load.average.length === 3 && load.average.every((value) => Number.isFinite(value) && value >= 0) ? load.average : null;
  return average && Number.isInteger(load.cpus) && load.cpus > 0 && Number.isInteger(load.freeMB) && load.freeMB >= 0
    ? { average, cpus: load.cpus, freeMB: load.freeMB } : null;
}
