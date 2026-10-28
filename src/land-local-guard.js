/** Run a named local-trunk floor without reading or writing a full-gate tree stamp [B3,R3,C7]. */
import { runnerExecutionServices } from './runners.js';
import { landingExecutionServices } from './landing-shards.js';
import { runProfiledShell } from './gate.js';
import { pinRunMain } from './gate.js';
import { withLandingGateSlot } from './gate.js';
import { testsNeedBrowser } from './browser-admission.js';
import { testsNeedGui } from './gui-admission.js';
import { browserFreeChecksEnabled } from './settings.js';
import { flakeLedger } from './board.js';
import { Refused } from './refused.js';

/** Retain native admission, complete stage output and failure observation under the actual run's lease. */
export async function runLocalLandingGuard(root, config, { files, directory, label, onWait, waivers, onFailure }) {
  const browser = !browserFreeChecksEnabled() || await testsNeedBrowser(root, files);
  return withLandingGateSlot(root, async lease => {
    pinRunMain(lease, onFailure);
    const run = runProfiledShell(root, config.gate, { waitMs: lease.waitMs, gateLease: lease,
      stages: true, landing: true, waivers, persistLog: true, artifactDirectory: directory, artifactPrefix: label,
      timeoutMs: config.landing?.timeoutMs });
    if (!run.isGreen && !run.timedOut) await onFailure(run, { root, command: config.gate, lease });
    return { ...run, log: run.logPath };
  }, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, landing: true, browser, gui: testsNeedGui(root, files), agent: 'coordinator', kind: 'land-guards', onWait });
}

/** An observed baseline red or missing comparison is not evidence against any item in a local batch. */
export function requireLocalGuardClassification(state, gate) {
  if (state.config.flakes?.rerun !== true) return;
  const recorded = gate.flakeDiagnostics?.observations ?? [];
  if (gate.flakeDiagnostics?.error || !recorded.length || recorded.some(row => !row.recorded || row.classification === 'unclassified')) {
    throw new Refused('LAND_DIAGNOSTIC', 'the local-trunk red has no complete classified diagnostic; inspect its recorded gate');
  }
  const ids = new Set(recorded.map(row => row.id));
  const observations = flakeLedger(state.board).flatMap(row => row.observations).filter(row => ids.has(row.id));
  const classified = gate.failures.length > 0 && gate.failures.every(failure => observations.some(row =>
    row.file === failure.file && row.name === failure.name && row.main === state.batch.base
    && (row.classification === 'flake' || row.classification === 'possible-regression' && row.mainReceipt?.green === true)));
  if (!classified) throw new Refused('LAND_DIAGNOSTIC', 'the local-trunk red also fails on main or lacks a positive main comparison; no item is returned');
}
