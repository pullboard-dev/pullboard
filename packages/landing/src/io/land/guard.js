/** Run a named local-trunk floor without reading or writing a full-gate tree stamp [B3,R3,C7]. */
import { runnerExecutionServices } from '../../../../runners/index.js';
import { landingExecutionServices } from '../shards.js';
import { browserFreeChecksEnabled } from '../../../../config/light.js';

import { readFileSync } from 'node:fs';
import { Refused } from '../../../../kernel/index.js';

/**
 * Retain native admission, complete stage output and failure observation under the actual run's lease.
 *
 * @param {object} ports - The gate functions the guard calls: runProfiledShellAsync, pinRunMain, withLandingGateSlot, landingControllerPlacement, testsNeedBrowser and testsNeedGui.
 * Why ports: the guard's logic file then imports nothing from the gate door; the step that runs it passes the real ones [C7,#8567].
 */
export async function runLocalLandingGuard(root, config, { files, directory, label, onWait, waivers, onFailure, quarantines = [], proofContext }, ports) {
  const { runProfiledShellAsync, pinRunMain, withLandingGateSlot, landingControllerPlacement, testsNeedBrowser, testsNeedGui } = ports;
  const browser = !browserFreeChecksEnabled() || await testsNeedBrowser(root, files);
  return withLandingGateSlot(root, async lease => {
    pinRunMain(lease, onFailure);
    lease.quarantines = quarantines;
    if (quarantines.length) lease.proof = proofContext;
    // Awaited, so the lander's landing lease keeps its heartbeat while the guard runs (9 Nov, LAND_LEASE_LOST) [C7].
    const run = await runProfiledShellAsync(root, config.gate, { waitMs: lease.waitMs, gateLease: lease,
      // Every named file runs to completion, so main's first known red never leaves the rest unrun [C7,#3167].
      stages: true, landing: true, collectAll: true, waivers, persistLog: true, artifactDirectory: directory, artifactPrefix: label,
      timeoutMs: config.landing?.timeoutMs });
    if (!run.isGreen && !run.timedOut) await onFailure(run, { root, command: config.gate, lease });
    return { ...run, log: run.logPath };
  }, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, landing: true, browser, gui: testsNeedGui(root, files), agent: 'coordinator', kind: 'land-guards', onWait,
    // The guard's controller stays here when landing shards, so run-tests fans its files out to the runners [C7,#3158].
    ...landingControllerPlacement(root) });
}

/** An observed baseline red or missing comparison is not evidence against any item in a local batch. */
export function requireLocalGuardClassification(state, gate) {
  if (state.config.flakes?.rerun !== true) return;
  const recorded = gate.flakeDiagnostics?.observations ?? [];
  // No measurement exists to classify after an observer error; diagnose will isolate each failing file once.
  if (gate.flakeDiagnostics?.error && !recorded.length) return;
  if (gate.flakeDiagnostics?.error || !recorded.length || recorded.some(row => !row.recorded || row.classification === 'unclassified')) {
    throw new Refused('LAND_DIAGNOSTIC', 'the local-trunk red has no complete classified diagnostic; inspect its recorded gate');
  }
  const ids = new Set(recorded.map(row => row.id));
  const observations = state.landingPorts.flakeLedger(state.board).flatMap(row => row.observations).filter(row => ids.has(row.id));
  const classified = gate.failures.length > 0 && gate.failures.every(failure => observations.some(row =>
    row.file === failure.file && row.name === failure.name && row.main === state.batch.base
    && (row.classification === 'flake' || row.classification === 'possible-regression' && row.mainReceipt?.green === true)));
  if (!classified) throw new Refused('LAND_DIAGNOSTIC', 'the local-trunk red also fails on main or lacks a positive main comparison; no item is returned');
}

/**
 * A red guard run that never ran a case because resources.sqlite stayed locked is infrastructure, not a verdict:
 * refuse SLOT_DB_LOCKED so the landing fault path keeps the batch and retries, never LAND_DIAGNOSTIC [C7,#3314].
 * Why: batch 3aa5b65d was refused LAND_DIAGNOSTIC with no failing case, only "[SLOT_DB_LOCKED] never ran" in its log.
 */
export function requireNoLockOnlyRed(gate, readLog = path => readFileSync(path, 'utf8')) {
  if (gate.isGreen || (gate.failures ?? []).length || !gate.logPath) return;
  let text = '';
  try { text = String(readLog(gate.logPath)); } catch { return; }
  if (text.includes('[SLOT_DB_LOCKED]')) throw new Refused('SLOT_DB_LOCKED', 'the local-trunk guards never ran: resources.sqlite stayed locked; the landing retries');
}

/** A shard's settled line: `# landing shard 2/6 attempt 1 on host: refused (runner refused: SLOT_DB_LOCKED) in 47407 ms`. */
const SHARD_LINE = /^# landing shard (\S+) attempt \d+ on \S+: (\w+)(?: \(([^)]*)\))?/u;
/** A runner that could not run tests: its refusal, a lost transport, or a run-tests queue that never started. */
const RUNNER_REFUSAL = /runner refused: ([A-Z_]+)|runner transport lost|\[([A-Z_]+)\] never ran/u;

/**
 * The runner refusal codes of a red gate log that names no failing case, or null when any test decided against it.
 * Null when a TAP case is `not ok`, a `# fail` count is above zero, a shard settled red, a shard was refused for a
 * non-runner reason, or no runner refusal is named at all [C7,#3693].
 *
 * @param {string} text - The gate's whole log.
 * @returns {string[] | null}
 */
export function runnerRefusalOnly(text) {
  const codes = new Set();
  const last = new Map();
  for (const line of String(text).split('\n')) {
    if (/^\s*not ok\b/u.test(line) || /^\s*# fail [1-9]/u.test(line)) return null;
    const shard = SHARD_LINE.exec(line);
    if (shard) last.set(shard[1], { status: shard[2], reason: shard[3] ?? '' });
    const refusal = RUNNER_REFUSAL.exec(line);
    if (refusal) codes.add(refusal[1] ?? refusal[2] ?? 'RUNNER_TRANSPORT_LOST');
  }
  for (const { status, reason } of last.values()) {
    if (status === 'red') return null;
    if ((status === 'refused' || status === 'infrastructure') && !RUNNER_REFUSAL.test(reason)) return null;
  }
  return codes.size ? [...codes].sort() : null;
}

/**
 * A red landing gate with no failing case whose only non-green shards are runner refusals (SLOT_DB_LOCKED, a lost
 * transport, a queue that never ran) is infrastructure: refuse LAND_RUNNER_FAULT, a landing fault that is retried and
 * never files LAND_DIAGNOSTIC or counts toward parking [C7,#3693].
 * Why: #2550 parked after two such gates (batches bc96678a, 30aab1ea): every shard that ran was green, so the
 * no-culprit diagnosis refused LAND_DIAGNOSTIC twice and the repeat guard held an item that did nothing wrong.
 */
export function requireNoRunnerRefusalOnlyRed(gate, readLog = path => readFileSync(path, 'utf8')) {
  if (gate.isGreen || gate.timedOut || (gate.failures ?? []).length || !gate.logPath) return;
  let text = '';
  try { text = String(readLog(gate.logPath)); } catch { return; }
  const codes = runnerRefusalOnly(text);
  if (codes) throw new Refused('LAND_RUNNER_FAULT', `the landing gate named no failing case; only runner refusals stopped it (${codes.join(', ')}); the landing retries`);
}
