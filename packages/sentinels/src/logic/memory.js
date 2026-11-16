/**
 * The scratch-memory warning: the file-event daemon (fseventsd) past 4 GB, or swap past 75 percent, is a finding that
 * names the process and its size. Pure: the shell reads the process list and swap, this decides [C7].
 *
 * Why: on 25 Oct a laptop's fseventsd reached 30 GB and swap 37 of 39 GB under test churn, and nothing said so.
 */

export const FSEVENTSD_LIMIT_BYTES = 4 * 1024 ** 3;
export const SWAP_LIMIT_RATIO = 0.75;

/** A byte count as a short size, GB from 1 GB up and MB below it. */
function size(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Findings for a process list `[{ pid, name, bytes }]` and a swap reading `{ usedBytes, totalBytes }`; none under
 * both limits. `since` carries an earlier finding's start so one episode keeps one identity across scans.
 */
export function scratchMemoryFindings({ processes = [], swap = null, host = 'this machine', since = () => null, now }) {
  const found = [];
  const started = key => since(key) ?? now.toISOString();
  for (const proc of processes.filter(row => row.name === 'fseventsd' && row.bytes > FSEVENTSD_LIMIT_BYTES)) {
    const key = `SCRATCH_MEMORY:${encodeURIComponent(host)}:fseventsd:${proc.pid}`;
    found.push({ key, cause: 'SCRATCH_MEMORY', item: null, subject: `pid ${proc.pid}`, title: `fseventsd holds ${size(proc.bytes)}`,
      since: started(key), why: `fseventsd (pid ${proc.pid}) holds ${size(proc.bytes)} on ${host}, over the ${size(FSEVENTSD_LIMIT_BYTES)} limit`,
      next: 'stop test churn in watched folders, then restart fseventsd or reboot', owner: null });
  }
  if (swap && swap.totalBytes > 0 && swap.usedBytes / swap.totalBytes > SWAP_LIMIT_RATIO) {
    const key = `SCRATCH_MEMORY:${encodeURIComponent(host)}:swap`;
    const largest = [...processes].sort((left, right) => right.bytes - left.bytes)[0];
    const percent = Math.round(100 * swap.usedBytes / swap.totalBytes);
    found.push({ key, cause: 'SCRATCH_MEMORY', item: null, subject: 'swap', title: `swap is ${percent}% used (${size(swap.usedBytes)} of ${size(swap.totalBytes)})`,
      since: started(key), why: `swap on ${host} is over ${Math.round(SWAP_LIMIT_RATIO * 100)}%${largest ? `; largest process ${largest.name} (pid ${largest.pid}) holds ${size(largest.bytes)}` : ''}`,
      next: 'stop the largest process or the test runs churning memory', owner: null });
  }
  return found;
}
