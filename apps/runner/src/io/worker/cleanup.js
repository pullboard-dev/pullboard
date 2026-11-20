/** Report and bound the runner worker's post-run cleanup so a stuck drain fails by name [C7]. */
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { join } from 'node:path';
import { processCensus } from '../custody.js';
import { cleanupTimeoutDetails } from '../../../../../packages/runners/light.js';

const fs = fileSystemAdapter();

/** Write a file created owner-only, as the adapter's plain writeFile takes no mode [C7]. */
function writePrivate(path, text) {
  const descriptor = fs.open(path, 'w', 0o600);
  try { fs.write(descriptor, text); } finally { fs.close(descriptor); }
}

const CLEANUP_BUDGET_MS = 30_000;

/** Start the post-run budget once; later cleanup phases cannot extend it. */
export function beginCleanup(S) {
  if (Number.isFinite(S.cleanupDeadline)) return;
  S.cleanupDeadline = Math.min(S.cleanupDeadline, Date.now() + CLEANUP_BUDGET_MS);
  S.cleanupTimer = setTimeout(() => reportCleanupTimeout(S), CLEANUP_BUDGET_MS);
  S.cleanupTimer.unref();
}

/** Bound an intermediate install drain without starting or extending the final/disconnect budget. */
export function beginPhaseCleanup(S) {
  if (Number.isFinite(S.phaseCleanupDeadline)) return;
  S.phaseCleanupDeadline = Date.now() + CLEANUP_BUDGET_MS;
  S.phaseCleanupTimer = setTimeout(() => reportCleanupTimeout(S), CLEANUP_BUDGET_MS);
  S.phaseCleanupTimer.unref();
}

/** A fully verified successful intermediate drain is the only boundary allowed to clear its own timer. */
export function clearPhaseCleanup(S) {
  if (Date.now() >= Math.min(S.cleanupDeadline, S.phaseCleanupDeadline)) {
    reportCleanupTimeout(S);
    return false;
  }
  if (S.transportLost || S.cleanupTimedOut || Number.isFinite(S.cleanupDeadline) || S.ownedChildren.size) return false;
  clearTimeout(S.phaseCleanupTimer);
  S.phaseCleanupTimer = null;
  S.phaseCleanupDeadline = Infinity;
  return true;
}

/** Report an unresolved cleanup once so the controller can fail without retrying the command. */
export function reportCleanupTimeout(S) {
  if (S.cleanupTimedOut || Date.now() < Math.min(S.cleanupDeadline, S.phaseCleanupDeadline)) return;
  S.cleanupTimedOut = true;
  const details = cleanupTimeoutDetails(S, (S.cleanupCensus ?? processCensus)({ includeCommand: true }));
  // A timeout may arrive after ordinary job deletion while output is still flushing.
  // Retain every waited-on process, naming executables without their arguments or environment.
  if (S.cleanupDirectory) {
    try {
      fs.mkdir(S.cleanupDirectory, { recursive: true, mode: 0o700 });
      writePrivate(join(S.cleanupDirectory, 'cleanup-timeout.json'), JSON.stringify(details) + '\n');
    } catch { /* The named red result remains authoritative if diagnostic storage fails. */ }
  }
  // The result already went out: the unverified leftovers stay on the runner for the sweep, never in the gate's verdict (#2538).
  if (S.resultSent) return;
  process.stderr.write(`PULLBOARD_RUNNER_CLEANUP_DETAILS ${S.workerId} ${Buffer.from(JSON.stringify(details)).toString('base64')}\n`);
  process.stderr.write(`PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${S.workerId} ${details.reason || S.cleanupStage}\n`);
  process.stderr.write(`PULLBOARD_RUNNER_CLEANUP_TIMEOUT ${S.workerId}\n`);
}

/** Retry a drained holder's real deletion instead of abandoning its row after a transient write failure. */
export async function releaseDrainedLease(S, lease) {
  let reported = false;
  for (;;) {
    try { lease.release({ retryMs: 0 }); return; }
    catch {
      reportCleanupTimeout(S);
      if (!reported) {
        // Parent death can close the transport before stderr arrives; retain this real failed attempt in the private job.
        if (S.cleanupDirectory) {
          try {
            const pending = join(S.cleanupDirectory, 'release-pending.json');
            const temporary = pending + '.tmp';
            writePrivate(temporary,
              JSON.stringify({ id: S.workerId, stage: 'lease release', pending: true, observedAt: new Date().toISOString() }) + '\n');
            fs.rename(temporary, pending);
          }
          catch { /* The live retry and named cleanup timeout remain authoritative if diagnostic storage fails. */ }
        }
        process.stderr.write(`PULLBOARD_RUNNER_RELEASE_PENDING ${S.workerId}\n`);
        reported = true;
      }
      // The lease and its database stay open until deletion commits; the normal cleanup budget reports a persistent failure.
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
