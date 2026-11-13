/**
 * The local runner's process side: on a machine with no registered runners the board host is its own runner. One
 * process per machine holds the local runner folder's lock, keeps a heartbeat in its state file, and runs runner serve
 * against the board API on loopback for each board that asked for it, the same pull path any runner takes [P7].
 *
 * The folder holds `boards.json` (the board roots it serves), `state.json` (pid, runner id, API address, heartbeat),
 * `lock` (a directory, taken with mkdir) and one cache per board.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { spawnReachable } from '../../../jobs/index.js';
import { serveRunner } from './pull.js';

/** The capability only a runner on the board host has: it reaches the board host's own repository by its path. */
export const BOARD_HOST = 'board-host';
// Budget: the local runner rewrites its state every 5 s; a state 30 s old belongs to a process that is gone or stuck.
const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
// Budget: a board the runner cannot serve yet (no board file, a refusal) is tried again after 1 s, doubling to a minute.
const RETRY = { firstMs: 1_000, maxMs: 60_000 };

/** Read a JSON file, or the fallback when it is missing or damaged. */
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Write a JSON file whole: a reader sees the old text or the new, never half. */
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

/** True while a process with this pid exists. */
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/**
 * The running local runner's state, or null when none runs: its pid is alive and its heartbeat is recent.
 * @param {string} folder
 * @param {number} [now]
 * @returns {{ pid: number, runner: string, url: string | null, heartbeatAt: number } | null}
 */
export function localRunnerState(folder, now = Date.now()) {
  const state = readJson(join(folder, 'state.json'), null);
  if (!state || !processAlive(state.pid) || !(now - Number(state.heartbeatAt) < STALE_MS)) return null;
  return state;
}

/** The board roots the local runner serves, those still on disk. */
export function localBoards(folder) {
  const roots = readJson(join(folder, 'boards.json'), []);
  return Array.isArray(roots) ? roots.filter(root => typeof root === 'string' && existsSync(root)) : [];
}

/** Add a board root to the ones the local runner serves; a running local runner picks it up at its next heartbeat. */
export function addLocalBoard(folder, root) {
  const board = resolve(root), roots = localBoards(folder);
  if (roots.includes(board)) return;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeJson(join(folder, 'boards.json'), [...roots, board]);
}

/**
 * Start the local runner process (`argv`, run by this Node) in the board's checkout, its output appended to the
 * folder's log; its pid, or null when it did not start. The process takes the lock itself, so a second start exits.
 *
 * @param {string} folder
 * @param {string[]} argv - The script and its arguments.
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 * @returns {Promise<number | null>}
 */
export async function startLocalRunner(folder, argv, { cwd, env }) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return (await spawnReachable(process.execPath, argv, { cwd, env, log: join(folder, 'runner.log') })).pid;
}

/** Take the folder's lock, or answer false while a live local runner holds it; a dead holder's lock is taken over. */
function takeLock(folder) {
  const lock = join(folder, 'lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(lock); return true; } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    if (localRunnerState(folder)) return false;
    rmSync(lock, { recursive: true, force: true });
  }
  return false;
}

/**
 * Serve one board until the signal stops it: runner serve against its loopback URL. A refusal is logged and tried
 * again later, so the local runner never stops serving a board on one error.
 */
async function serveBoard({ root, id }, { origin, key, runner, folder, capabilities, handlers, admit, signal, say }) {
  const cache = join(folder, 'cache', createHash('sha256').update(root).digest('hex').slice(0, 16));
  for (let wait = RETRY.firstMs; !signal.aborted; wait = Math.min(wait * 2, RETRY.maxMs)) {
    try {
      say(`serving ${root} as board ${id}`);
      // One job at a time on the board host: concurrent jobs belong on runners, never on the coordinator Mac (#5805).
      await serveRunner({ board: `${origin}/api/v1/boards/${id}`, key, runner, capabilities, cache, handlers, admit, jobs: 1, signal, say: line => say(`${basename(root)}: ${line}`) });
      wait = RETRY.firstMs;
    } catch (error) {
      if (signal.aborted) break;
      say(`${root}: ${error?.code ?? 'ERROR'} ${error?.message ?? error}; trying again in ${wait} ms`);
    }
    await pause(wait, null, { signal }).catch(() => { /* stopped */ });
  }
}

/**
 * Run the machine's local runner until the signal aborts: take the lock, open the board API on loopback, heartbeat,
 * and serve every board `open` lists, picking up boards added while it runs. On stop each running job is handed back
 * (serveRunner releases it), then the API closes and the state and lock are removed.
 *
 * @param {object} options
 * @param {string} options.folder - The local runner folder.
 * @param {() => Promise<{ origin: string, key: string, boards: () => Array<{ root: string, id: string }>, close: () => Promise<void> }>} options.open - Starts
 *   the board API on loopback; boards lists the boards it serves with their ids.
 * @param {string[]} options.capabilities - What this runner offers, BOARD_HOST among them.
 * @param {Parameters<typeof serveRunner>[0]['handlers']} [options.handlers]
 * @param {() => boolean} [options.admit] - Asked before each claim; the local runner takes a job only while it says yes.
 * @param {AbortSignal} options.signal
 * @param {(line: string) => void} [options.say]
 * @param {{ heartbeatMs?: number }} [options.timing]
 * @returns {Promise<{ served: boolean, pid: number }>} served false when another local runner (pid) already runs.
 */
export async function serveLocalRunner({ folder, open, capabilities, handlers = {}, admit, signal, say = () => {}, timing = {} }) {
  const { heartbeatMs = HEARTBEAT_MS } = timing;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!takeLock(folder)) return { served: false, pid: localRunnerState(folder)?.pid ?? null };
  const runner = `local-${hostname().replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 40) || 'host'}-${process.pid}`;
  const state = { pid: process.pid, runner, url: null };
  const beat = () => writeJson(join(folder, 'state.json'), { ...state, heartbeatAt: Date.now() });
  beat();
  const heartbeat = setInterval(beat, heartbeatMs);
  const loops = new Map();
  let api = null;
  try {
    api = await open();
    state.url = `${api.origin}/api/v1/boards`;
    beat();
    say(`local runner ${runner} pulling from ${state.url}`);
    while (!signal.aborted) {
      for (const board of api.boards()) {
        if (!loops.has(board.root)) loops.set(board.root, serveBoard(board, { origin: api.origin, key: api.key, runner, folder, capabilities, handlers, admit, signal, say }));
      }
      await pause(heartbeatMs, null, { signal }).catch(() => { /* stopped */ });
    }
    say('stopping: handing back any running job');
    await Promise.allSettled(loops.values());
    return { served: true, pid: process.pid };
  } finally {
    clearInterval(heartbeat);
    await api?.close().catch(() => { /* already closed */ });
    rmSync(join(folder, 'state.json'), { force: true });
    rmSync(join(folder, 'lock'), { recursive: true, force: true });
    say('stopped');
  }
}
