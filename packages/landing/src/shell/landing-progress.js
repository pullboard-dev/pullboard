/** Stop a landing batch only after ten minutes with no recorded or observed work [B3,R3]. */
export const LANDING_STALL_MS = 10 * 60 * 1000;

/** Capture the batch revision, active log size and live runner identities used to judge progress. */
export function landingProgressSnapshot(batch, { logBytes = 0, runnerJobs = [] } = {}) {
  return { id: batch?.id ?? null, revision: batch?.revision ?? null, state: batch?.state ?? null,
    logPath: batch?.logPath ?? null, logBytes, runnerJobs: [...runnerJobs].sort() };
}

/** Treat a board advance, new runner process or additional log bytes as progress. */
export function landingProgressed(previous, current) {
  if (!previous || previous.id !== current.id || previous.revision !== current.revision || previous.state !== current.state) return true;
  if (current.logBytes > previous.logBytes) return true;
  const priorJobs = new Set(previous.runnerJobs);
  return current.runnerJobs.some(job => !priorJobs.has(job));
}

/** Tell whether an active batch crossed its inactivity limit. */
export function landingStallExpired(lastProgressAt, now, timeoutMs = LANDING_STALL_MS) {
  return Number.isFinite(lastProgressAt) && Number.isFinite(now) && now - lastProgressAt >= timeoutMs;
}

/** Name the recorded state and latest step in a durable no-progress explanation. */
export function landingStallDescription(batch, step) {
  return `batch ${batch.id} made no progress for 10 minutes in state ${batch.state}; last step ${step}`;
}
