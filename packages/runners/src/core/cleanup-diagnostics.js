/** Preserve every process lifetime a failed runner drain was waiting on [C7]. */

/** Merge custody and still-open child records without exposing arguments or dropping long process lists. */
export function cleanupTimeoutDetails(state) {
  const custody = state.cleanupDetails?.() ?? {};
  const processes = new Map();
  for (const row of [...(custody.pending ?? []), ...(custody.live ?? []), ...(custody.roots ?? []), ...state.ownedChildren.values()]) {
    if (!Number.isSafeInteger(row.pid) || row.pid < 1) continue;
    const key = `${row.pid}:${row.birth ?? row.started ?? ''}`;
    const previous = processes.get(key);
    processes.set(key, { pid: row.pid, birth: row.birth ?? previous?.birth ?? null,
      command: previous?.command ?? row.command ?? null, started: previous?.started ?? row.started ?? null });
  }
  return { id: state.workerId, stage: state.cleanupStage, ...custody, processes: [...processes.values()] };
}

/** Accept only this worker's structured process evidence, never another request's control frame. */
export function readCleanupTimeoutDetails(encoded, id) {
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (value?.id !== id || typeof value.stage !== 'string' || !Array.isArray(value.processes)
      || value.processes.some(row => !Number.isSafeInteger(row.pid) || row.pid < 1
        || !['command', 'started', 'birth'].every(key => row[key] === null || typeof row[key] === 'string'))) return null;
    return value;
  } catch { return null; }
}

/** Include all recorded identities in the refusal; unknown fields remain explicitly unknown. */
export function cleanupProcessText(details) {
  return details.processes.map(row => `pid=${row.pid} command=${JSON.stringify(row.command)} started=${JSON.stringify(row.started)} birth=${JSON.stringify(row.birth)}`).join('; ');
}
