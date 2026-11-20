/** A claim keeps its seat alive for as long as the agent session that took it lives [B3,C7]. */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';
import { storeName } from './store-names.js';
import { environmentAdapter } from '../../../../packages/env/index.js';

const fs = fileSystemAdapter();

/** The beater's cadence: four beats inside the two-minute seat-gone limit, so one missed beat never costs a claim. */
export const BEATER_EVERY_MS = 30_000;

/** How long a seat may make no board event and no file change in its folder before its beater stops: the stale capture's seat-gone idle setting, 30 minutes. */
export const BEATER_QUIET_MS = 30 * 60_000;

/** Presence is not progress: the events a seat's own beats and renewals write never count as its work. */
const PRESENCE_EVENTS = ['claim', 'renew', 'heartbeat', 'claim_stalled'];

/** The most entries one folder walk reads, so a huge folder never stalls a beat. */
const WALK_LIMIT = 4000;

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
export function agentSession({ env = environmentAdapter(), ppid = process.ppid, table = processTable() } = {}) {
  const named = Number(env.get('PULLBOARD_AGENT_PID'));
  if (Number.isSafeInteger(named) && named > 1) {
    const row = table?.get(named);
    return table && !row ? null : { pid: named, start: row?.start ?? null, named: true };
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

/**
 * The newest modification time, in ms, of any file under `dir`, or null when none can be read. Git's own folder and
 * installed packages are skipped, and the walk stops at WALK_LIMIT entries.
 */
export function folderActivity(dir, { list = (path) => fs.list(path, { withFileTypes: true }), stat = (path) => fs.stat(path) } = {}) {
  let newest = null;
  let seen = 0;
  const pending = [dir];
  while (pending.length && seen < WALK_LIMIT) {
    const here = pending.pop();
    let entries;
    try { entries = list(here); } catch { continue; }
    for (const entry of entries) {
      if (++seen > WALK_LIMIT) break;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(here, entry.name);
      if (entry.isDirectory()) { pending.push(path); continue; }
      try { const at = stat(path).mtimeMs; if (newest === null || at > newest) newest = at; } catch { /* gone since the listing */ }
    }
  }
  return newest;
}

/** The seat's latest board event that is real work, in ms, or null; a board that cannot be read this tick says null. */
async function seatEventAt(board, seat) {
  let opened, store;
  try {
    store = await import('../../../../packages/store/index.js');
    opened = store.openBoardForRead(board);
    const at = opened?.db.prepare(`SELECT event_at FROM event WHERE event_by=? AND event_kind NOT IN (${PRESENCE_EVENTS.map(() => '?').join(',')}) ORDER BY event_id DESC LIMIT 1`).get(seat, ...PRESENCE_EVENTS)?.event_at;
    return at ? Date.parse(at) : null;
  } catch { return null; }
  finally { try { if (opened) store.closeBoard(opened); } catch { /* already closed */ } }
}

/** The lock file naming the beater that keeps `seat` alive, beside the board's private seat files. */
function beaterLock(board, seat) { return join(dirname(board), 'beaters', `${storeName(encodeURIComponent(seat))}`); }

/** The recorded beater for `seat`, or null. */
function readLock(lock) { try { return JSON.parse(fs.readFile(lock, 'utf8')); } catch { return null; } }

/** Whether a beater lock beside `lock`, not this seat's own, names a live beater watching the same agent process. */
function otherBeaterWatches(lock, agent, alive) {
  let names;
  try { names = fs.list(dirname(lock)); } catch { return false; }
  return names.some((name) => {
    const path = join(dirname(lock), name);
    if (path === lock) return false;
    const other = readLock(path);
    return other?.agent?.pid === agent.pid && other.agent.start === agent.start && Number.isSafeInteger(other.pid) && alive({ pid: other.pid, start: null });
  });
}

/**
 * Start the detached beater for `seat` on the board file `board`, bound to the agent session behind this CLI call; it
 * beats every 30 s until the seat holds no claim, the session exits or the seat's worktree is gone. A beater already
 * watching the same session is kept. Resolves to what it did; it never throws, because the claim is already recorded.
 * Why: on 11 Nov 43 of 45 live seats lost a claim while editing or running native tests outside the CLI: only CLI
 * writes, hooks and submit's keepalive beat, and Codex seats have no hooks [B3,C7].
 */
export async function startClaimBeater(cwd, { seat, board }, { env = environmentAdapter(), session = () => agentSession({ env }), launch = null, alive = agentAlive } = {}) {
  try {
    if (env.get('PULLBOARD_CLAIM_BEATER') === '0') return { started: false, reason: 'off' };
    if (typeof seat !== 'string' || !seat || typeof board !== 'string' || !board) return { started: false, reason: 'no seat' };
    const agent = session();
    if (!agent) return { started: false, reason: 'no agent session' };
    const lock = beaterLock(board, seat);
    const held = readLock(lock);
    if (held?.agent?.pid === agent.pid && held.agent.start === agent.start && alive({ pid: held.pid, start: null })) {
      return { started: false, reason: 'running', pid: held.pid };
    }
    // Another seat's live beater already watching this ancestor means the ancestor outlives the worker: the new beater is recorded as shared and the quiet-seat rule governs it.
    const shared = !agent.named && otherBeaterWatches(lock, agent, alive);
    const entry = fileURLToPath(new URL('./beater/run.js', import.meta.url));
    const args = [JSON.stringify({ cwd, seat, board, lock, agent, shared, everyMs: Number(env.get('PULLBOARD_BEATER_MS')) || BEATER_EVERY_MS })];
    // The beater drops the lock only while it names the beater, so recording it after the launch is safe.
    fs.mkdir(dirname(lock), { recursive: true });
    // The drive cell loads here, once a beater really starts, so a claim with no agent session never pays for it [C7].
    const pid = (launch ?? (await import('../../../../packages/drive/index.js')).startDetachedCheck)(entry, { args, cwd, env: { ...env.all(), PULLBOARD_CLAIM_BEATER: '0' } });
    if (!pid) return { started: false, reason: 'launch failed' };
    // The adapter's file write takes no mode, so the lock opens by descriptor to stay private to its owner.
    const descriptor = fs.open(lock, 'w', 0o600);
    try { fs.write(descriptor, JSON.stringify({ version: 1, pid, agent, seat, shared }) + '\n'); } finally { fs.close(descriptor); }
    return { started: true, pid, agent, shared };
  } catch (error) { return { started: false, reason: error?.message ?? String(error) }; }
}

/**
 * The beater's whole life: beat the seat while it holds a claim, its worktree exists and the agent session lives, then
 * drop its lock if the lock is still its own. A dead agent stops the beats within one tick, so the two-minute
 * seat-gone release still takes its claim. The gate cell loads here, in the detached process, never in the claim.
 * A `remote` binding ({ url, token, agent, seatKey? }, a seat joined by board.url) beats the board host through
 * sendRemoteHeartbeat instead of a local board, and stops once the host refuses a beat or the lock names another beater [P7,B3].
 */
export async function runBeater({ cwd, seat, board, lock, agent, everyMs = BEATER_EVERY_MS, remote = null, quietMs = BEATER_QUIET_MS }, { alive: agentUp = agentAlive, pid = process.pid, send = null, now = Date.now, lastEvent = seatEventAt, lastFileChange = folderActivity, wait = null, ...options } = {}) {
  // The seat is quiet when it made no board event and changed no file in its folder for quietMs, whatever the watched pid does [B3].
  let lastWork = now();
  const refresh = async () => {
    const found = [await lastEvent(board, seat), lastFileChange(cwd)].filter((at) => Number.isFinite(at));
    lastWork = Math.max(lastWork, ...found);
  };
  const alive = (watched) => agentUp(watched) && now() - lastWork < quietMs;
  const pause = async (ms) => { await refresh(); await (wait ?? ((span) => new Promise((done) => setTimeout(done, span))))(ms); };
  options = { ...options, wait: pause };
  try {
    const { keepClaimsAlive } = await import('../../../../packages/gate/heavy.js');
    if (remote?.url) {
      const post = send ?? (await import('./remote/moves.js')).sendRemoteHeartbeat;
      let refused = false;
      let named = false;
      return await keepClaimsAlive(cwd, { everyMs, alive: () => alive(agent), seatOf: () => ({ seat, file: board }),
        beat: async () => { if (!(await post(remote))) refused = true; },
        held: async () => {
          const owner = readLock(lock)?.pid;
          if (owner === pid) named = true;
          return !refused && (owner === pid || (owner === undefined && !named));
        }, ...options });
    }
    return await keepClaimsAlive(cwd, { everyMs, alive: () => alive(agent),
      // Any file in the board's folder names the board, so the binding names the board itself.
      seatOf: () => ({ seat, file: board }), ...options });
  } finally {
    if (readLock(lock)?.pid === pid) fs.rm(lock, { force: true });
  }
}
