/** Sweep dead runner job folders, trim repos and cache to a budget, and keep an absolute amount of disk free; a live job is never touched [C7]. */
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readlinkSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statfsSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { isAbsolute } from 'node:path';
import { sep } from 'node:path';
import { Refused } from '../../../../packages/kernel/light.js';
import { environmentAdapter } from '../../../../packages/env/index.js';
import { processCensus } from './custody.js';
import { acquireResourceApi } from './worker/environment.js';
import { DatabaseSync } from 'node:sqlite';
import { maintainTestResults } from './results.js';

const GIB = 1024 ** 3;
export const DEFAULT_REPOS_BUDGET = 15 * GIB;
export const DEFAULT_CACHE_BUDGET = 10 * GIB;
/** The free space a runner keeps after its sweep when no gate.diskFloorMB setting says otherwise: 10 GB, never a percentage. */
export const DEFAULT_MIN_FREE_BYTES = 10 * GIB;
/** A job folder with no live process and no terminal result is abandoned after this long without a write. */
const ABANDONED_MS = 24 * 60 * 60 * 1000;
/** The file a worker writes once its result is delivered; a folder with it holds nothing still running. */
export const TERMINAL_RESULT = 'job-terminal.json';
const PIN = 'source-cache-pin.json';

/** Read free and total bytes of the filesystem holding a path; null when it cannot be observed. */
export function diskSpace(path) {
  try { const stat = statfsSync(path); return { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize }; }
  catch { return null; }
}

/** Sum the bytes under a path without following links, stopping early at the deadline. */
export function treeBytes(path, deadline = Infinity) {
  let total = 0;
  let stat;
  try { stat = lstatSync(path); } catch { return 0; }
  total += stat.blocks * 512;
  if (!stat.isDirectory() || Date.now() > deadline) return total;
  let names = [];
  try { names = readdirSync(path); } catch { return total; }
  for (const name of names) total += treeBytes(join(path, name), deadline);
  return total;
}

/** Newest modification time anywhere in a path's top two levels, used as its last use. */
function lastUse(path) {
  let newest = 0;
  try { newest = lstatSync(path).mtimeMs; } catch { return 0; }
  try {
    for (const name of readdirSync(path)) newest = Math.max(newest, lstatSync(join(path, name)).mtimeMs);
  } catch { /* A plain file or unreadable directory keeps its own time. */ }
  return newest;
}

/** Names of job folders that hold a process working directory, or null when that cannot be observed. */
function folderHolders(jobs) {
  const inside = path => { const part = relative(jobs, path); return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part) ? part.split(sep)[0] : null; };
  const held = new Set();
  if (process.platform === 'linux') {
    let pids;
    try { pids = readdirSync('/proc').filter(name => /^[1-9]\d*$/u.test(name)); } catch { return null; }
    for (const pid of pids) {
      try { const name = inside(readlinkSync(`/proc/${pid}/cwd`)); if (name) held.add(name); }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) return null; }
    }
    return held;
  }
  const observed = spawnSync('/usr/sbin/lsof', ['-nP', '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 8_000, maxBuffer: 16 * 1024 * 1024 });
  if (observed.error || observed.signal || typeof observed.stdout !== 'string') return null;
  for (const line of observed.stdout.split('\n')) {
    if (!line.startsWith('n')) continue;
    const name = inside(line.slice(1).replace(/^\/var\//u, '/private/var/'));
    if (name) held.add(name);
  }
  return held;
}

/**
 * Decide whether a job folder is still in use. The worker's owner record is its lease: a folder is live while that exact
 * process runs, while any process works inside it, while any process of its recorded process group runs, and while it has
 * no owner record, unless it holds a terminal result or has been quiet for 24 hours. Anything unreadable is live. Elapsed
 * time never decides a removal: a live job that is merely quiet keeps its folder [#3734].
 */
export function jobFolderLive(jobs, name, { census, held, now }) {
  const directory = join(jobs, name);
  let stat;
  try { stat = lstatSync(directory); } catch { return false; }
  if (!stat.isDirectory() || held.has(name)) return true;
  let owner;
  try { owner = JSON.parse(readFileSync(join(directory, 'worker-owner.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') return true;
    // No owner record proves no process is dead, so only a terminal result or 24 quiet hours releases the folder [#3734].
    return !(hasTerminalResult(directory) || now - newestWrite(directory) >= ABANDONED_MS);
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.started !== 'string') return true;
  const row = census.get(owner.pid);
  if (row && !row.state.startsWith('Z') && row.started === owner.started) return true;
  if (!row) {
    try { process.kill(owner.pid, 0); return true; }
    catch (error) { if (error.code !== 'ESRCH') return true; }
  }
  return !ownerGone(directory, owner, census, now);
}

/** Record that a job delivered its result, so the sweep may remove its folder even if the worker dies [#3734]. */
export function writeTerminalResult(directory) {
  writeFileSync(join(directory, TERMINAL_RESULT), '{}\n', { mode: 0o600 });
}

/** Whether a job folder holds a terminal result, written once its worker delivered the job's result. */
function hasTerminalResult(directory) {
  try { return lstatSync(join(directory, TERMINAL_RESULT)).isFile(); } catch { return false; }
}

/**
 * True when a job folder whose owner process is gone may be removed, in only two cases: (a) it holds a terminal result and
 * no live process of the job is left, or (b) it is abandoned: no live process of the job, no terminal result, and no write
 * anywhere in it for 24 hours. "No live process" is the owner's recorded process group having no live census member; a record
 * without a group (written by an older worker) shows no process either way, so only the 24-hour rule applies to it.
 */
function ownerGone(directory, owner, census, now) {
  if (Number.isSafeInteger(owner.pgid) && owner.pgid > 0) {
    for (const row of census.values()) if (row.pgid === owner.pgid && !/^Z/u.test(row.state)) return false;
  }
  return hasTerminalResult(directory) || now - newestWrite(directory) >= ABANDONED_MS;
}

/** Newest modification time in a bounded walk of a folder, so deep activity under a job counts as use. */
function newestWrite(directory, budget = { left: 20_000 }, depth = 0) {
  let newest = 0;
  try { newest = lstatSync(directory).mtimeMs; } catch { return 0; }
  if (depth > 6) return newest;
  let entries = [];
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return newest; }
  for (const entry of entries) {
    if (--budget.left < 0) return Date.now();
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) newest = Math.max(newest, newestWrite(path, budget, depth + 1));
    else { try { newest = Math.max(newest, lstatSync(path).mtimeMs); } catch { /* Gone while walking. */ } }
  }
  return newest;
}

/** Read actual machine gate holders; an unreadable lease database is never evidence of idleness. */
function leasedJobs(machineHome) {
  const file = join(machineHome, 'resources.sqlite');
  let db;
  try {
    lstatSync(file);
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare("SELECT agent FROM holder WHERE name='gate' AND agent LIKE 'pullboard-ssh-%'").all()
      .map(row => row.agent.slice('pullboard-ssh-'.length));
  } catch (error) { return error.code === 'ENOENT' ? [] : null; }
  finally { db?.close(); }
}

/** Any remaining pin protects its repository; an unreadable pin makes custody unknown. */
function pinnedRepos(jobs) {
  const repos = new Set();
  let names;
  try { names = readdirSync(jobs); } catch (error) { return error.code === 'ENOENT' ? repos : null; }
  for (const name of names) {
    try {
      const pin = JSON.parse(readFileSync(join(jobs, name, PIN), 'utf8'));
      if (!/^[a-f0-9]{64}$/u.test(pin.repoId)) return null;
      repos.add(pin.repoId);
    } catch (error) { if (error.code !== 'ENOENT') return null; }
  }
  return repos;
}

/** Group a runner root's repos and cache entries into trimmable units with size and last use. */
function storeUnits(root, pinned, anyLive, deadline) {
  const units = [];
  const add = (kind, key, paths) => {
    const existing = paths.filter(path => { try { lstatSync(path); return true; } catch { return false; } });
    if (!existing.length) return;
    units.push({ kind, key, paths: existing, bytes: existing.reduce((sum, path) => sum + treeBytes(path, deadline), 0),
      used: Math.max(...existing.map(lastUse)), protected: kind === 'repos' ? pinned.has(key) : key !== 'npm' && anyLive });
  };
  const groups = new Map();
  try {
    for (const name of readdirSync(join(root, 'repos'))) {
      if (name.startsWith('.repo-')) continue;
      const key = name.split('.')[0];
      groups.set(key, [...(groups.get(key) ?? []), join(root, 'repos', name)]);
    }
  } catch { /* No repos directory means nothing to trim. */ }
  for (const [key, paths] of groups) add('repos', key, paths);
  try {
    for (const name of readdirSync(join(root, 'cache'))) if (name !== 'resource-pool') add('cache', name, [join(root, 'cache', name)]);
  } catch { /* No cache directory means nothing to trim. */ }
  return units;
}

/**
 * Sweep one runner root: remove every job folder with no live owner, then trim repos and cache oldest-use first to their
 * budgets, then keep trimming until at least the free-space floor (default 10 GB) is free. Live job folders and the repos they pin are never touched.
 *
 * @param {string} root - The runner root, normally ~/.pullboard-runner.
 * @param {{ census?: () => Map<number, object>|null, diskFree?: (path: string) => {free: number, total: number}|null,
 *   now?: number, deadline?: number, reposBudget?: number, cacheBudget?: number, minFreeBytes?: number }} [options]
 * @returns {{ skipped?: string, removedJobs: string[], abandonedJobs: string[], keptJobs: string[], trimmed: string[], freeBytes: number|null }}
 */
export async function sweepRunnerDisk(root, { api, machineHome, onLeaseWait = () => {}, census = processCensus, diskFree = diskSpace, now = Date.now(), deadline = Infinity,
  reposBudget = DEFAULT_REPOS_BUDGET, cacheBudget = DEFAULT_CACHE_BUDGET, minFreeBytes = DEFAULT_MIN_FREE_BYTES } = {}) {
  const report = { removedJobs: [], abandonedJobs: [], keptJobs: [], trimmed: [], freeBytes: null };
  const freeNow = () => { const space = diskFree(root); return space && space.total > 0 ? space.free : null; };
  const jobs = join(root, 'jobs');
  const observed = census();
  const held = folderHolders(jobs);
  const leases = machineHome ? leasedJobs(machineHome) : null;
  if (!observed || !held || !leases) { report.skipped = 'custody unavailable'; report.freeBytes = freeNow(); return report; }
  let names = [];
  try { names = readdirSync(jobs); } catch { /* No jobs directory means no dead folders. */ }
  const live = [];
  for (const name of names) {
    if (leases.some(id => name.startsWith(id + '-')) || jobFolderLive(jobs, name, { census: observed, held, now })) { live.push(name); report.keptJobs.push(name); continue; }
    if (Date.now() > deadline) { report.keptJobs.push(name); continue; }
    const currentLeases = leasedJobs(machineHome), currentCensus = census(), currentHeld = folderHolders(jobs);
    if (!currentLeases || !currentCensus || !currentHeld || currentLeases.some(id => name.startsWith(id + '-')) || jobFolderLive(jobs, name, { census: currentCensus, held: currentHeld, now: Date.now() })) { report.keptJobs.push(name); continue; }
    const abandoned = !hasTerminalResult(join(jobs, name));
    try {
      rmSync(join(jobs, name), { recursive: true, force: true }); report.removedJobs.push(name);
      if (abandoned) { report.abandonedJobs.push(name); process.stderr.write(`PULLBOARD_RUNNER_JOB_ABANDONED job=${name}\n`); }
    }
    catch { report.keptJobs.push(name); }
  }
  const pins = pinnedRepos(jobs);
  if (!pins) { report.skipped = 'pin custody unavailable'; report.freeBytes = freeNow(); return report; }
  report.testResults = maintainTestResults(root, { held: pins });
  const units = storeUnits(root, pins, live.length > 0, deadline);
  const total = kind => units.filter(unit => unit.kind === kind).reduce((sum, unit) => sum + unit.bytes, 0);
  const sizes = { repos: total('repos'), cache: total('cache') };
  const budgets = { repos: reposBudget, cache: cacheBudget };
  for (const unit of units.sort((a, b) => a.used - b.used)) {
    const free = freeNow();
    const overBudget = sizes[unit.kind] > budgets[unit.kind];
    if (unit.protected || Date.now() > deadline || !overBudget && (free === null || free >= minFreeBytes)) continue;
    let lease;
    try {
      if (unit.kind === 'repos') {
        if (!api || !/^[a-f0-9]{64}$/u.test(unit.key)) continue;
        lease = await acquireResourceApi(api, { name: `repo-${unit.key}`, capacity: 1, scope: 'machine', root, repo: root,
          agent: `pullboard-ssh-sweep-${process.pid}`, kind: 'source-cache',
          onWait: () => { onLeaseWait(unit.key); if (Date.now() >= deadline) throw new Error('sweep deadline'); } }, join(root, 'cache', 'resource-pool'));
        const currentPins = pinnedRepos(jobs);
        if (!currentPins || currentPins.has(unit.key)) continue;
      } else {
        if (!api || unit.key !== 'npm') continue;
        lease = await acquireResourceApi(api, { name: 'cache-npm', capacity: 1, scope: 'machine', root, repo: root,
          agent: `pullboard-ssh-sweep-${process.pid}`, kind: 'dependency-cache',
          onWait: () => { onLeaseWait(unit.key); if (Date.now() >= deadline) throw new Error('sweep deadline'); } }, join(root, 'cache', 'resource-pool'));
      }
      for (const path of unit.paths) rmSync(path, { recursive: true, force: true });
      sizes[unit.kind] -= unit.bytes;
      report.trimmed.push(`${unit.kind}/${unit.key}`);
    } catch { /* Keep anything whose lease or deletion cannot be proved safe. */ }
    finally { lease?.release(); }
  }
  report.freeBytes = freeNow();
  return report;
}

/** Read a whole-number byte budget from the environment, falling back when it is unset or invalid. */
function envBytes(name, fallback) {
  const raw = environmentAdapter().get(name);
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && raw !== '' ? value : fallback;
}

/**
 * The free-space floor this runner keeps, in bytes: gate.diskFloorMB from the machine home's settings.json (declared in
 * packages/config, validated there), else 10 GB. An unreadable or invalid value falls back to the default, never to a percentage.
 */
export function diskFloorBytes(machineHome) {
  try {
    const megabytes = JSON.parse(readFileSync(join(machineHome, 'settings.json'), 'utf8')).gate?.diskFloorMB;
    return Number.isSafeInteger(megabytes) && megabytes >= 0 ? megabytes * 1024 ** 2 : DEFAULT_MIN_FREE_BYTES;
  } catch { return DEFAULT_MIN_FREE_BYTES; }
}

/**
 * Run the sweep for the worker with budgets from PULLBOARD_RUNNER_REPOS_BUDGET_BYTES and PULLBOARD_RUNNER_CACHE_BUDGET_BYTES.
 * Return no report on failure so admission can fail closed when capacity cannot be verified.
 */
export async function sweepRunnerDiskForWorker(root, workerId, deadline, api, machineHome) {
  try {
    const report = await sweepRunnerDisk(root, { api, machineHome, deadline, reposBudget: envBytes('PULLBOARD_RUNNER_REPOS_BUDGET_BYTES', DEFAULT_REPOS_BUDGET),
      cacheBudget: envBytes('PULLBOARD_RUNNER_CACHE_BUDGET_BYTES', DEFAULT_CACHE_BUDGET), minFreeBytes: diskFloorBytes(machineHome) });
    if (report.removedJobs.length || report.trimmed.length || report.skipped) {
      process.stderr.write(`PULLBOARD_RUNNER_DISK_SWEEP ${workerId} jobs=${report.removedJobs.length} trimmed=${report.trimmed.length} free=${report.freeBytes === null ? 'unknown' : (report.freeBytes / GIB).toFixed(1) + 'GB'}${report.skipped ? ' skipped=' + report.skipped.replace(/\s+/gu, '-') : ''}\n`);
    }
    return report;
  } catch { process.stderr.write(`PULLBOARD_RUNNER_DISK_SWEEP ${workerId} unavailable\n`); return null; }
}

/**
 * Refuse admission when the swept disk is below the floor or its free space cannot be verified.
 */
export function assertDiskFree(report, minFreeBytes = DEFAULT_MIN_FREE_BYTES) {
  if (report && Number.isFinite(report.freeBytes) && report.freeBytes >= minFreeBytes) return;
  if (!report || !Number.isFinite(report.freeBytes)) throw new Refused('RUNNER_DISK_FULL', 'runner free disk space could not be verified; inspect the runner disk before retrying');
  throw new Refused('RUNNER_DISK_FULL', `this runner has ${(report.freeBytes / GIB).toFixed(1)} GB of disk free after a sweep, below its ${(minFreeBytes / GIB).toFixed(1)} GB floor; free space on the runner, lower PULLBOARD_RUNNER_REPOS_BUDGET_BYTES and PULLBOARD_RUNNER_CACHE_BUDGET_BYTES, or set gate.diskFloorMB`);
}
