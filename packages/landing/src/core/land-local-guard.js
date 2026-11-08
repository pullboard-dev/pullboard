/** Run a named local-trunk floor without reading or writing a full-gate tree stamp [B3,R3,C7]. */
import { runnerExecutionServices } from '../../../runners/index.js';
import { landingExecutionServices } from '../shell/landing-shards.js';
import { runProfiledShell } from '../../../gate/index.js';
import { pinRunMain } from '../../../gate/index.js';
import { withLandingGateSlot } from '../../../gate/index.js';
import { landingControllerPlacement } from '../../../gate/index.js';
import { testsNeedBrowser } from '../../../gate/index.js';
import { testsNeedGui } from '../../../gate/index.js';
import { browserFreeChecksEnabled } from '../../../config/index.js';

import { readFileSync } from 'node:fs';
import { Refused } from '../../../kernel/index.js';

/** Retain native admission, complete stage output and failure observation under the actual run's lease. */
export async function runLocalLandingGuard(root, config, { files, directory, label, onWait, waivers, onFailure, quarantines = [], proofContext }) {
  const browser = !browserFreeChecksEnabled() || await testsNeedBrowser(root, files);
  return withLandingGateSlot(root, async lease => {
    pinRunMain(lease, onFailure);
    lease.quarantines = quarantines;
    if (quarantines.length) lease.proof = proofContext;
    const run = runProfiledShell(root, config.gate, { waitMs: lease.waitMs, gateLease: lease,
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
