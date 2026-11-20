/** The per-runner status mirror: one ssh per runner per 3 s however many jobs wait, read from a local file by everyone [5465,5468]. */
import { closeSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { statusScript } from './scripts.js';
import { pullJobId } from './scripts.js';
import { createSshAdapter } from '../adapter/ssh.js';
import { runnerStatusDir } from './ssh.js';
import { storeName } from '../store-names.js';
import { environmentAdapter } from '../../../../env/index.js';

/** Every ssh call in this file goes through the ssh runner adapter. */
const sshAdapter = createSshAdapter();

export const MIRROR_INTERVAL_MS = 3_000;
export const MIRROR_LOCK_STALE_MS = 15_000;
/** Failed refreshes in a row before a runner counts as unreachable (about ten seconds at the refresh cadence). */
export const MIRROR_UNREACHABLE_AFTER = 3;

/** A host as a safe file name. */
function hostFile(host) {
  const name = String(host).replace(/[^A-Za-z0-9._@-]/gu, '_');
  return name.startsWith('.') ? `_${name}` : name;
}

/** The mirror file for one runner host. */
export function mirrorFile(host, dir = runnerStatusDir()) { return join(dir, storeName(hostFile(host))); }

/** The folder of per-job markers (`<id>.wanted`, `<id>.cancel`, `<id>.ack`) the next refresh sends to the runner. */
function markerDir(host, dir) { return join(dir, `${hostFile(host)}.jobs`); }

/**
 * Read a runner's mirror.
 * @param {string} host The runner host.
 * @param {{ dir?: string }} [options] The status folder.
 * @returns {{ at: number, reachable: boolean, failures: number, agent: string, jobs: object }|null} The mirror, or null when none is readable.
 */
export function readRunnerMirror(host, { dir = runnerStatusDir() } = {}) {
  try { return JSON.parse(readFileSync(mirrorFile(host, dir), 'utf8')); } catch { return null; }
}

/** Write a marker file atomically enough: a marker is only ever read whole or not found. */
function mark(host, id, kind, dir, text = '') {
  pullJobId(id);
  const folder = markerDir(host, dir);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, `${id}.${kind}`), text, { mode: 0o600 });
}

/** Say a job is wanted by this process: refreshes keep touching its `wanted` file while the pid lives. */
export function registerRunnerJob(host, id, { dir = runnerStatusDir(), pid = process.pid } = {}) { mark(host, id, 'wanted', dir, String(pid)); }

/** Ask the runner to stop a job (a queued one is simply removed); sent by the next refresh, at most 3 s away. */
export function requestRunnerCancel(host, id, { dir = runnerStatusDir() } = {}) { mark(host, id, 'cancel', dir); }

/** Tell the runner a finished job's folder can go, and stop keeping the job wanted. */
export function ackRunnerJob(host, id, { dir = runnerStatusDir() } = {}) { mark(host, id, 'ack', dir); }

/** Whether a process id is alive (a permission error still means alive). */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Read the markers: wanted ids whose owner lives (dead owners are dropped so the runner reclaims their jobs), cancels and acks. */
function markers(host, dir) {
  const folder = markerDir(host, dir), found = { wanted: [], cancel: [], ack: [] };
  let names = [];
  try { names = readdirSync(folder); } catch { return found; }
  for (const name of names) {
    const dot = name.lastIndexOf('.'), id = name.slice(0, dot), kind = name.slice(dot + 1);
    if (!(kind in found)) continue;
    if (kind === 'wanted') {
      let pid = 0;
      try { pid = Number(readFileSync(join(folder, name), 'utf8')); } catch { continue; }
      if (alive(pid)) found.wanted.push(id); else rmSync(join(folder, name), { force: true });
    } else found[kind].push(id);
  }
  return found;
}

/** Turn the status script's text into jobs; null when the closing `end` is missing (a cut connection). */
export function parseStatus(text) {
  const lines = text.split('\n');
  if (lines.at(-2) !== 'end' && lines.at(-1) !== 'end') return null;
  let agent = 'absent', load;
  const jobs = {};
  for (const line of lines) {
    if (line.startsWith('agent ')) agent = line.slice(6).trim();
    if (line.startsWith('load ')) load = parseLoad(line.slice(5));
    if (!line.startsWith('job ')) continue;
    const [, id, ...fields] = line.split(' ');
    const value = Object.fromEntries(fields.map(field => [field.slice(0, field.indexOf('=')), field.slice(field.indexOf('=') + 1)]));
    let exit;
    try { exit = value.exit && value.exit !== '-' ? JSON.parse(value.exit) : undefined; } catch { exit = { code: null, signal: 'UNREADABLE' }; }
    jobs[id] = { state: value.state, ready: value.ready === '1', beatAgeMs: value.beat === '-' ? null : Number(value.beat) * 1000,
      alive: value.alive === '-' ? null : value.alive === '1', ...(exit ? { exit } : {}), resultSeen: Number(value.result) > 0,
      ...(value.need && value.need !== '-' ? { need: value.need } : {}) };
  }
  return { agent, jobs, ...(load ? { load } : {}) };
}

/**
 * Read the agent's load line into the mirror: whether it holds new jobs, and why in words.
 * Why: a runner that stops pulling at its core count must say so, or a queued job looks like a lost one [#5578].
 */
function parseLoad(text) {
  const value = Object.fromEntries(text.trim().split(' ').map(field => [field.slice(0, field.indexOf('=')), field.slice(field.indexOf('=') + 1)]));
  const average = Number(value.load), cores = Number(value.cores);
  if (!Number.isFinite(average) || !Number.isFinite(cores) || cores < 1 || (value.state !== 'ok' && value.state !== 'hold')) return undefined;
  const holding = value.state === 'hold';
  return { holding, average, cores, perCore: average / cores, at: Number(value.at) * 1000,
    ...(holding ? { reason: `one-minute load ${average} is at or above its ${cores} cores; takes no new job until it drops below` } : {}) };
}

/** Publish the mirror whole: a reader sees the old file or the new one. */
function publish(file, mirror) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(mirror), { mode: 0o600 });
  renameSync(temporary, file);
}

/** Take the refresh lock (O_EXCL); a lock older than 15 s belongs to a dead refresher and is replaced. */
function lockRefresh(file, now) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = openSync(file, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); return true; }
    catch (error) {
      if (error.code !== 'EEXIST') return false;
      try { if (now - statSync(file).mtimeMs <= MIRROR_LOCK_STALE_MS) return false; unlinkSync(file); } catch { /* A winner just released it. */ }
    }
  }
  return false;
}

/**
 * Bring a runner's mirror up to date if it is older than `intervalMs`, with one ssh (shell, not node) however many callers ask.
 * Whoever finds the mirror stale takes the lock and refreshes it; everyone else gets the file as it stands.
 * @param {{ host: string, root?: string }} runner The runner record.
 * @param {{ dir?: string, now?: () => number, intervalMs?: number, ssh?: string, env?: object, timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<{ mirror: object|null, refreshed: boolean }>} The mirror now on disk and whether this call refreshed it.
 */
export async function refreshRunnerStatus(runner, { dir = runnerStatusDir(), now = Date.now, intervalMs = MIRROR_INTERVAL_MS, ssh = 'ssh', env = environmentAdapter().all(), timeoutMs = 10_000, force = false } = {}) {
  const file = mirrorFile(runner.host, dir), fresh = () => { const m = readRunnerMirror(runner.host, { dir }); return m && now() - m.at < intervalMs ? m : null; };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!force && fresh()) return { mirror: fresh(), refreshed: false };
  const lock = `${join(dir, hostFile(runner.host))}.lock`;
  if (!lockRefresh(lock, now())) return { mirror: readRunnerMirror(runner.host, { dir }), refreshed: false };
  try {
    if (!force && fresh()) return { mirror: fresh(), refreshed: false };
    const sent = markers(runner.host, dir), previous = readRunnerMirror(runner.host, { dir });
    const stdin = [...sent.wanted.map(id => `W ${id}`), ...sent.cancel.map(id => `C ${id}`), ...sent.ack.map(id => `A ${id}`)].join('\n');
    const at = now();
    const run = await sshAdapter.run(runner, statusScript(runner), { stdin: stdin ? `${stdin}\n` : '', ssh, env, dir, timeoutMs });
    const parsed = run.status === 0 && !run.error ? parseStatus(run.stdout.toString('utf8')) : null;
    const failures = parsed ? 0 : (previous?.failures ?? 0) + 1;
    const mirror = parsed ? { version: 1, at, reachable: true, failures, ...parsed }
      : { version: 1, jobs: {}, agent: 'unknown', ...previous, at, reachable: failures < MIRROR_UNREACHABLE_AFTER, failures, error: run.error ?? (run.stderr.trim().split('\n').at(-1) || `status ${run.status}`) };
    publish(file, mirror);
    if (parsed) {
      const folder = markerDir(runner.host, dir);
      for (const id of sent.cancel) rmSync(join(folder, `${id}.cancel`), { force: true });
      for (const id of sent.ack) for (const kind of ['ack', 'wanted']) rmSync(join(folder, `${id}.${kind}`), { force: true });
    }
    return { mirror, refreshed: true };
  } finally { rmSync(lock, { force: true }); }
}
