/** Sample cumulative CPU for a test process and its live descendants [C7,V10]. */
import { spawnSync } from 'node:child_process';

/** Parse POSIX ps CPU times with optional hours and fractional seconds. */
function micros(value) {
  const parts = value.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isFinite(part) || part < 0)) return null;
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1_000_000);
}

/** A failed or malformed census is unknown, never evidence that the tree is idle. */
export function processTreeCpu(root) {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart=,time='], { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return null;
  const rows = new Map();
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s*$/u.exec(line);
    if (!match) return null;
    const pid = Number(match[1]), ppid = Number(match[2]), cpu = micros(match[4]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || cpu === null || rows.has(pid)) return null;
    rows.set(pid, { pid, ppid, key: `${pid}:${match[3]}`, cpu });
  }
  if (!rows.has(root)) return null;
  const reached = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows.values()) if (row.pid !== result.pid && reached.has(row.ppid) && !reached.has(row.pid)) {
      reached.add(row.pid); changed = true;
    }
  }
  return new Map([...reached].filter(pid => pid !== result.pid).map(pid => {
    const row = rows.get(pid); return [row.key, row.cpu];
  }));
}

/** Count work observed on live identities, including newly seen children and never a reused PID. */
export function treeCpuDelta(previous, current) {
  let total = 0;
  for (const [key, value] of current) total += Math.max(0, value - (previous.get(key) ?? 0));
  return total;
}
