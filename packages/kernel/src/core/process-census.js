/** Parse one all-process POSIX census for the runner worker's cleanup checks [C7]. */
import { createHash } from 'node:crypto';

/**
 * Parse `ps -axo pid=,ppid=,pgid=,lstart=,stat=,comm=` output into rows keyed by pid.
 * A malformed census is never read as an empty machine, so any row it cannot trust returns null.
 * Rows with no process group (pgid 0) are skipped: Linux lists its kernel threads that way, and
 * they can never belong to a worker's process groups. Rejecting them made every census on a real
 * Linux host null, so runner cleanup could never be verified.
 *
 * @param {string} stdout - The census text.
 * @returns {Map<number, {pid:number, ppid:number, pgid:number, started:string, state:string, processSha256:string}>|null}
 */
export function parseProcessCensus(stdout) {
  const rows = new Map();
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) return null;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (![pid, ppid, pgid].every(Number.isSafeInteger) || pid < 1 || ppid < 0 || pgid < 0 || rows.has(pid)) return null;
    if (pgid === 0) continue;
    const started = `${match[4]} ${match[5]} ${match[6]} ${match[7]} ${match[8]}`;
    const processSha256 = createHash('sha256').update(match[10]).digest('hex');
    rows.set(pid, { pid, ppid, pgid, started, state: match[9], processSha256 });
  }
  return rows.size ? rows : null;
}
