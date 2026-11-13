/** Stop a landing batch after two minutes with no recorded or observed work [B3,R3,C7,#5816]. */
export const LANDING_STALL_MS = 2 * 60 * 1000;

/** Capture the batch revision, active log size and live runner identities used to judge progress. */
export function landingProgressSnapshot(batch, { logBytes = 0, runnerJobs = [], cpuMs = 0 } = {}) {
  return { id: batch?.id ?? null, revision: batch?.revision ?? null, state: batch?.state ?? null,
    logPath: batch?.logPath ?? null, logBytes, runnerJobs: [...runnerJobs].sort(), cpuMs };
}

/**
 * Treat a board advance, new runner process, additional log bytes or more CPU time spent by the worker's own
 * descendants as progress. Why: the gate log is written when a run ends and a local plan scan starts no runner job,
 * so on 6 Nov three two-item batches were stopped while their scan was still computing [B3,R3].
 */
export function landingProgressed(previous, current) {
  if (!previous || previous.id !== current.id || previous.revision !== current.revision || previous.state !== current.state) return true;
  if (current.logBytes > previous.logBytes) return true;
  if ((current.cpuMs ?? 0) > (previous.cpuMs ?? 0)) return true;
  const priorJobs = new Set(previous.runnerJobs);
  return current.runnerJobs.some(job => !priorJobs.has(job));
}

/** Tell whether an active batch crossed its inactivity limit. */
export function landingStallExpired(lastProgressAt, now, timeoutMs = LANDING_STALL_MS) {
  return Number.isFinite(lastProgressAt) && Number.isFinite(now) && now - lastProgressAt >= timeoutMs;
}

/** Name the limit, the recorded state and the latest step in a durable no-progress explanation. */
export function landingStallDescription(batch, step, limitMs = LANDING_STALL_MS) {
  const limit = limitMs % 60_000 === 0 ? `${limitMs / 60_000} minute${limitMs === 60_000 ? '' : 's'}` : `${Math.round(limitMs / 1000)} s`;
  return `batch ${batch.id} made no progress for ${limit} in state ${batch.state}; last step ${step}`;
}
