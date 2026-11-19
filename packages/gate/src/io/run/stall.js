/** A local gate run whose process tree makes no output, CPU or process change for the stall interval is a named stall, not a silent hold [C7]. */
import { environmentAdapter } from '../../../../env/index.js';

/** Longer than the 11 minute per-test ceiling, so a hung test is ended by its own watchdog first. */
export const DEFAULT_RUN_STALL_MS = 900_000;
/** Overrides the stall interval for every local run; 0 turns the watch off. */
export const RUN_STALL_ENV = 'PULLBOARD_RUN_STALL_MS';

/**
 * Read the stall interval: the explicit option, else the environment, else the default. 0 turns the watch off.
 *
 * @param {number|string|undefined} [given] - An explicit interval in milliseconds.
 * @returns {number}
 */
export function runStallMs(given = environmentAdapter().get(RUN_STALL_ENV)) {
  if (given === undefined || given === '') return DEFAULT_RUN_STALL_MS;
  const parsed = Number(given);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) throw new Error(`${RUN_STALL_ENV} must be 0 (off) or a positive integer no greater than 2147483647 milliseconds`);
  return parsed;
}

/**
 * Read the machine's process rows as { pid, ppid, pgid, cpu, command }; null when the census itself failed, which never
 * counts as a stall. The caller supplies the spawn, so this file starts no process of its own.
 *
 * @param {(command: string, args: string[], options: object) => Promise<{ status: number|null, stdout: string, error?: Error }>} spawn
 * @returns {Promise<Array<{ pid: number, ppid: number, pgid: number, cpu: string, command: string }>|null>}
 */
export async function processRows(spawn) {
  const result = await spawn('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,time=,command='], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000, maxBuffer: 32 << 20, env: { ...environmentAdapter().all(), LC_ALL: 'C' } });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const rows = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/u.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), cpu: match[4], command: match[5] });
  }
  return rows;
}

/** The child's process group: its descendants and anything still in its group, as one signature that moves when a process appears, exits or spends CPU. */
function treeSignature(rows, rootPid) {
  const tree = rows.filter(row => row.pgid === rootPid || row.pid === rootPid);
  return { signature: tree.map(row => `${row.pid}:${row.cpu}`).sort().join(','), tree };
}

/**
 * Watch one spawned run. `onStall` fires once, with the idle time and the processes named, after `stallMs` with no new
 * output and an unchanged process and CPU signature. A failed census counts as progress.
 * Why: a run that hangs holds its slot at 0% CPU forever; this ends it by name so the slot is freed.
 *
 * @param {{ stallMs: number, onStall: (info: { idleMs: number, processes: string }) => void, intervalMs?: number, now?: () => number, rows: () => Array<object>|null|Promise<Array<object>|null> }} options
 * @returns {{ spawned: (child: { pid?: number }) => void, output: () => void, stop: () => void }}
 */
export function watchRun({ stallMs, onStall, intervalMs = Math.min(5_000, Math.max(10, Math.floor(stallMs / 4))), now = Date.now, rows }) {
  let rootPid = null, last = null, changedAt = now(), timer = null, stopped = false;
  /** Look again after one interval; the run's end calls stop, so no timer outlives it. */
  const next = () => { timer = setTimeout(check, intervalMs); };
  const check = async () => {
    const census = rootPid === null ? null : await rows();
    if (stopped) return;
    if (!census) { changedAt = now(); return next(); }
    const { signature, tree } = treeSignature(census, rootPid);
    if (signature !== last) { last = signature; changedAt = now(); return next(); }
    const idleMs = now() - changedAt;
    if (idleMs < stallMs) return next();
    const shown = tree.slice(0, 8).map(row => `${row.pid} ${row.command.slice(0, 80)}`).join('; ');
    onStall({ idleMs, processes: `${shown}${tree.length > 8 ? `; +${tree.length - 8} more` : ''}` });
  };
  if (stallMs > 0) next();
  return {
    spawned: child => { rootPid = child.pid ?? null; changedAt = now(); },
    output: () => { changedAt = now(); },
    stop: () => { stopped = true; clearTimeout(timer); },
  };
}
