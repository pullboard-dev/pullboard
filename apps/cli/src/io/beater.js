/** A claim keeps its seat alive for as long as the agent session that took it lives [B3,C7]. */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDetachedCheck } from '../../../../packages/drive/index.js';
import { storeName } from './store-names.js';

/** The beater's cadence: four beats inside the two-minute seat-gone limit, so one missed beat never costs a claim. */
export const BEATER_EVERY_MS = 30_000;

/**
 * Processes that only carry a command for the agent: a shell, or a wrapper that runs one command and exits.
 * Why: the CLI's own parent is the shell the agent opened for this one command, and it exits with the command.
 */
const CARRIERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'tcsh', 'csh', 'ash', 'busybox',
  'env', 'timeout', 'gtimeout', 'nice', 'nohup', 'time', 'xargs', 'sandbox-exec', 'npx', 'npm', 'pnpm', 'yarn']);

/** One process table row's command name, without its path or a login shell's leading dash. */
function commandName(comm) { return basename(String(comm).trim()).replace(/^-/u, ''); }

/**
 * Every process as pid -> { ppid, start, comm }, from one `ps` call; null where ps is unavailable.
 * The start time is ps's fixed-width lstart, kept to tell a live agent from a later process given the same pid.
 */
export function processTable(run = execFileSync) {
  let text;
  try { text = run('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 }); }
  catch { return null; }
  const table = new Map();
  for (const line of text.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S{3} \S{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/u.exec(line);
    if (row) table.set(Number(row[1]), { ppid: Number(row[2]), start: row[3], comm: row[4] });
  }
  return table;
}

/**
 * The agent session process behind this CLI call: the nearest ancestor that is not a shell or a command wrapper, with
 * its start time, or null when none can be found. PULLBOARD_AGENT_PID names it outright for an agent tool launched
 * some other way. Why: the CLI's parent shell exits after each command, so the beater watches the session, which
 * lives as long as the agent does, whatever tool it is [B3].
 */
export function agentSession({ env = process.env, ppid = process.ppid, table = processTable() } = {}) {
  const named = Number(env.PULLBOARD_AGENT_PID);
  if (Number.isSafeInteger(named) && named > 1) {
    const row = table?.get(named);
    return table && !row ? null : { pid: named, start: row?.start ?? null };
  }
  if (!table) return null;
  const seen = new Set();
  for (let pid = ppid; pid > 1 && !seen.has(pid); pid = table.get(pid)?.ppid ?? 0) {
    seen.add(pid);
    const row = table.get(pid);
    if (!row) return null;
    if (!CARRIERS.has(commandName(row.comm))) return { pid, start: row.start };
  }
  return null;
}

/**
 * Whether the watched agent session still runs: its pid answers and, where ps can say, it is no zombie and is the same
 * process that started at `start`. A pid reused by a later process, or one dead but not yet reaped, reads as gone.
 */
export function agentAlive({ pid, start }, { run = execFileSync, signal = process.kill } = {}) {
  try { signal(pid, 0); } catch (error) { if (error?.code !== 'EPERM') return false; }
  let row;
  try { row = /^\s*(\S+)\s+(.*?)\s*$/u.exec(run('ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch (error) { return error?.code === 'ENOENT'; }
  return Boolean(row) && !row[1].startsWith('Z') && (!start || row[2] === start);
}

/** The lock file naming the beater that keeps `seat` alive, beside the board's private seat files. */
function beaterLock(board, seat) { return join(dirname(board), 'beaters', `${storeName(encodeURIComponent(seat))}`); }

/** The recorded beater for `seat`, or null. */
function readLock(lock) { try { return JSON.parse(readFileSync(lock, 'utf8')); } catch { return null; } }

/**
 * Start the detached beater for `seat` on the board file `board`, bound to the agent session behind this CLI call; it
 * beats every 30 s until the seat holds no claim, the session exits or the seat's worktree is gone. A beater already
 * watching the same session is kept. Returns what it did; it never throws, because the claim is already recorded.
 * Why: on 11 Nov 43 of 45 live seats lost a claim while editing or running native tests outside the CLI: only CLI
 * writes, hooks and submit's keepalive beat, and Codex seats have no hooks [B3,C7].
 */
export function startClaimBeater(cwd, { seat, board }, { env = process.env, session = () => agentSession({ env }), launch = startDetachedCheck, alive = agentAlive } = {}) {
  try {
    if (env.PULLBOARD_CLAIM_BEATER === '0') return { started: false, reason: 'off' };
    if (typeof seat !== 'string' || !seat || typeof board !== 'string' || !board) return { started: false, reason: 'no seat' };
    const agent = session();
    if (!agent) return { started: false, reason: 'no agent session' };
    const lock = beaterLock(board, seat);
    const held = readLock(lock);
    if (held?.agent?.pid === agent.pid && held.agent.start === agent.start && alive({ pid: held.pid, start: null })) {
      return { started: false, reason: 'running', pid: held.pid };
    }
    const entry = fileURLToPath(new URL('./beater/run.js', import.meta.url));
    const args = [JSON.stringify({ cwd, seat, board, lock, agent, everyMs: Number(env.PULLBOARD_BEATER_MS) || BEATER_EVERY_MS })];
    // The beater drops the lock only while it names the beater, so recording it after the launch is safe.
    mkdirSync(dirname(lock), { recursive: true });
    const pid = launch(entry, { args, cwd, env: { ...env, PULLBOARD_CLAIM_BEATER: '0' } });
    if (!pid) return { started: false, reason: 'launch failed' };
    writeFileSync(lock, JSON.stringify({ version: 1, pid, agent, seat }) + '\n', { mode: 0o600 });
    return { started: true, pid, agent };
  } catch (error) { return { started: false, reason: error?.message ?? String(error) }; }
}

/**
 * The beater's whole life: beat the seat while it holds a claim, its worktree exists and the agent session lives, then
 * drop its lock if the lock is still its own. A dead agent stops the beats within one tick, so the two-minute
 * seat-gone release still takes its claim. The gate cell loads here, in the detached process, never in the claim.
 */
export async function runBeater({ cwd, seat, board, lock, agent, everyMs = BEATER_EVERY_MS }, { alive = agentAlive, pid = process.pid, ...options } = {}) {
  try {
    const { keepClaimsAlive } = await import('../../../../packages/gate/index.js');
    return await keepClaimsAlive(cwd, { everyMs, alive: () => alive(agent),
      // Any file in the board's folder names the board, so the binding names the board itself.
      seatOf: () => ({ seat, file: board }), ...options });
  } finally {
    if (readLock(lock)?.pid === pid) rmSync(lock, { force: true });
  }
}
