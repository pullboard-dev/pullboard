/** Preserve every process lifetime a failed runner drain was waiting on [C7]. */

/**
 * Walk a waited-on process's parents from a process census, each as pid and executable name. The walk ends at launchd
 * (pid 1) or at the job root, whichever comes first, so a person can see what started the process without reading ps.
 *
 * @param {number} pid - The waited-on process.
 * @param {Map<number, {ppid:number, command?:string}>|null} census - One all-process census, or null when unreadable.
 * @param {Set<number>} roots - The job's root pids, where the chain stops after naming them.
 * @returns {{pid:number, command:string|null}[]}
 */
export function parentChain(pid, census, roots = new Set()) {
  const chain = [];
  const seen = new Set([pid]);
  let at = census?.get(pid);
  while (at && chain.length < 32) {
    const parent = at.ppid;
    if (!Number.isSafeInteger(parent) || parent < 1 || seen.has(parent)) break;
    seen.add(parent);
    const row = census.get(parent);
    chain.push({ pid: parent, command: row?.command ?? null });
    if (parent === 1 || roots.has(parent)) break;
    at = row;
  }
  return chain;
}

/** Merge custody and still-open child records without exposing arguments or dropping long process lists. */
export function cleanupTimeoutDetails(state, census = null) {
  const custody = state.cleanupDetails?.() ?? {};
  const processes = new Map();
  for (const row of [...(custody.pending ?? []), ...(custody.live ?? []), ...(custody.roots ?? []), ...state.ownedChildren.values()]) {
    if (!Number.isSafeInteger(row.pid) || row.pid < 1) continue;
    const key = `${row.pid}:${row.birth ?? row.started ?? ''}`;
    const previous = processes.get(key);
    processes.set(key, { pid: row.pid, birth: row.birth ?? previous?.birth ?? null,
      command: previous?.command ?? row.command ?? null, started: previous?.started ?? row.started ?? null });
  }
  const roots = new Set((custody.roots ?? []).map(row => row.pid));
  const named = [...processes.values()].map(row => ({ ...row, parents: parentChain(row.pid, census, roots) }));
  return { id: state.workerId, stage: state.cleanupStage, ...custody, processes: named };
}

/** Accept only this worker's structured process evidence, never another request's control frame. */
export function readCleanupTimeoutDetails(encoded, id) {
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (value?.id !== id || typeof value.stage !== 'string' || !Array.isArray(value.processes)
      || value.processes.some(row => !Number.isSafeInteger(row.pid) || row.pid < 1
        || !['command', 'started', 'birth'].every(key => row[key] === null || typeof row[key] === 'string')
        || (row.parents !== undefined && !(Array.isArray(row.parents) && row.parents.every(parent => Number.isSafeInteger(parent?.pid)
          && (parent.command === null || typeof parent.command === 'string')))))) return null;
    return value;
  } catch { return null; }
}

/** Include all recorded identities in the refusal; unknown fields remain explicitly unknown. */
export function cleanupProcessText(details) {
  return details.processes.map(row => `pid=${row.pid} command=${JSON.stringify(row.command)} started=${JSON.stringify(row.started)} birth=${JSON.stringify(row.birth)}${parentText(row.parents)}`).join('; ');
}

/** Name the parent chain as pid and command pairs, nearest parent first; empty when none was observed. */
function parentText(parents) {
  if (!parents?.length) return '';
  return ` parents=[${parents.map(parent => `pid=${parent.pid} command=${JSON.stringify(parent.command)}`).join(' <- ')}]`;
}
