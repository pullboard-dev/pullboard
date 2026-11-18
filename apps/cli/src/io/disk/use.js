/** @pullboard-module-loads apps/cli/src/io/disk/use/worker.js */
/** What Pullboard keeps under .git/pullboard: its size per store, a warning threshold, and a retention policy for bulky raw material [C7]. */
import { startDetachedCheck } from '../../../../../packages/drive/light.js';
import { appendFileSync } from 'node:fs';
import { closeSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GIB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const POLICY_FILE = 'disk-policy.json';
const CACHE_FILE = 'disk-use-cache.json';
/** Present while a background measurement runs, so concurrent commands start only one. */
export const MEASURE_LOCK = 'disk-use.measuring';
const LOG_FILE = 'retention-log.jsonl';

/** The stores the board writes, by the top-level names they live under; any other name is counted as "other". */
export const DISK_STORES = (await import('../../../../../packages/gate/index.js')).diskStores();

/** Removal failures that mean the entry changed or is held while being removed, so the prune keeps it and goes on. */
const REMOVAL_RACES = new Set(['ENOTEMPTY', 'ENOENT', 'EBUSY', 'EPERM', 'EACCES']);

/** Only these stores hold raw material that may age out; every other store is kept forever. */
const AGING_STORES = ['worktree archives', 'test actions', 'flake evidence', 'check output'];

/** Safe defaults: warn at 20 GiB, keep raw material 30 days (14 for logs) and each store under a size cap. */
export const DEFAULT_DISK_POLICY = {
  warnBytes: 20 * GIB,
  retention: {
    'worktree archives': { maxAgeDays: 30, maxBytes: 20 * GIB },
    'test actions': { maxAgeDays: 14, maxBytes: 5 * GIB },
    'flake evidence': { maxAgeDays: 14, maxBytes: 1 * GIB },
    'check output': { maxAgeDays: 14, maxBytes: 1 * GIB },
  },
};

/** The bytes a path takes on disk, not following links; zero when it cannot be read. */
function bytesUnder(path) {
  let stat;
  try { stat = lstatSync(path); } catch { return 0; }
  let total = stat.blocks * 512;
  if (!stat.isDirectory()) return total;
  let names = [];
  try { names = readdirSync(path); } catch { return total; }
  for (const name of names) total += bytesUnder(join(path, name));
  return total;
}

/** The newest modification time of any file under a path (a folder's own time only when it holds none), so an entry is as old as the last file written in it. */
function newestMtime(path) {
  let stat;
  try { stat = lstatSync(path); } catch { return 0; }
  if (!stat.isDirectory()) return stat.mtimeMs;
  let names = [];
  try { names = readdirSync(path); } catch { return stat.mtimeMs; }
  if (!names.length) return stat.mtimeMs;
  let newest = 0;
  for (const name of names) newest = Math.max(newest, newestMtime(join(path, name)));
  return newest;
}

/** Which store a top-level name belongs to. */
function storeOf(name) {
  for (const [store, names] of Object.entries(DISK_STORES)) if (names.includes(name)) return store;
  return 'other';
}

/**
 * Read the policy: safe defaults, overridden by an optional disk-policy.json beside the stores.
 * A malformed file throws an Error coded DISK_POLICY_INVALID (the command turns it into a Refused) rather than guessed, because a wrong limit would delete the wrong things.
 */
export function diskPolicy(dir) {
  const policy = { warnBytes: DEFAULT_DISK_POLICY.warnBytes, retention: structuredClone(DEFAULT_DISK_POLICY.retention) };
  let text;
  try { text = readFileSync(join(dir, POLICY_FILE), 'utf8'); } catch { return policy; }
  const bad = (why) => Object.assign(new Error(`${POLICY_FILE} ${why}; fix or delete ${join(dir, POLICY_FILE)} to use the defaults`), { code: 'DISK_POLICY_INVALID' });
  let given;
  try { given = JSON.parse(text); } catch { throw bad('is not valid JSON'); }
  const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (given === null || typeof given !== 'object' || Array.isArray(given)) throw bad('must be a JSON object');
  if (given.warnBytes !== undefined) { if (!positive(given.warnBytes)) throw bad('warnBytes must be a positive number'); policy.warnBytes = given.warnBytes; }
  for (const [store, rule] of Object.entries(given.retention ?? {})) {
    if (!AGING_STORES.includes(store)) throw bad(`retention names "${store}", which is not an aging store (${AGING_STORES.join(', ')})`);
    for (const key of ['maxAgeDays', 'maxBytes']) {
      if (rule?.[key] === undefined) continue;
      if (!positive(rule[key])) throw bad(`retention "${store}" ${key} must be a positive number`);
      policy.retention[store][key] = rule[key];
    }
  }
  return policy;
}

/**
 * Measure each store and the total, and name the largest stores when the total crosses the warning threshold.
 * A fresh enough cached measurement is reused so a command on a 40 GB tree stays quick.
 */
export function diskUse(dir, { now = Date.now(), maxAgeMs = 0 } = {}) {
  const policy = diskPolicy(dir);
  let measured = null;
  if (maxAgeMs > 0) {
    try {
      const cached = JSON.parse(readFileSync(join(dir, CACHE_FILE), 'utf8'));
      if (now - cached.at >= 0 && now - cached.at < maxAgeMs && Array.isArray(cached.stores)) measured = cached.stores;
    } catch { /* no usable cache: measure */ }
  }
  if (!measured) {
    const sums = new Map();
    let names = [];
    try { names = readdirSync(dir); } catch { /* no store yet */ }
    for (const name of names) sums.set(storeOf(name), (sums.get(storeOf(name)) ?? 0) + bytesUnder(join(dir, name)));
    measured = [...sums].map(([name, bytes]) => ({ name, bytes }));
    try { writeFileSync(join(dir, CACHE_FILE), JSON.stringify({ at: now, stores: measured })); } catch { /* read-only: skip the cache */ }
  }
  return summarized(dir, measured, policy);
}

/** The per-store report for measured sizes: stores largest first, the total, and the warning when it applies. */
function summarized(dir, measured, policy) {
  const stores = measured.filter(row => row.name !== 'other' || row.bytes > 0).sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const total = stores.reduce((sum, row) => sum + row.bytes, 0);
  const warning = total > policy.warnBytes
    ? { totalBytes: total, thresholdBytes: policy.warnBytes, largest: stores.slice(0, 3).map(row => row.name) } : null;
  return { dir, total, stores, thresholdBytes: policy.warnBytes, warning };
}

/** A background measurement this old is taken to have died, and another may start. */
const MEASURE_LOCK_MS = 60 * 60_000;

/**
 * Start one detached measurement of the stores, unless one is already running; it writes the cache diskUse reads.
 * Returns whether one started. `launch` runs the worker; the drive cell's detached check by default.
 */
export function startDiskMeasure(dir, { now = Date.now(), launch = startDetachedCheck } = {}) {
  const lock = join(dir, MEASURE_LOCK);
  try {
    if (now - statSync(lock).mtimeMs < MEASURE_LOCK_MS) return false;
    rmSync(lock, { force: true });
  } catch { /* No measurement is running. */ }
  try { closeSync(openSync(lock, 'wx')); } catch { return false; }
  if (launch(fileURLToPath(new URL('./use/worker.js', import.meta.url)), { args: [dir] }) === null) {
    rmSync(lock, { force: true });
    return false;
  }
  return true;
}

/**
 * Disk use from the last measurement, never measured in the command: a stale or missing measurement starts one in the
 * background. Why: walking a large .git/pullboard took 6 minutes on 9 Nov, and status ran that walk every 10 minutes
 * inside the resident board process, so every seat's commands fell back to cold reads behind it [C7]. With no
 * measurement yet, the total is null and `measuring` is true.
 */
export function cachedDiskUse(dir, { now = Date.now(), maxAgeMs = 10 * 60_000, start = startDiskMeasure } = {}) {
  const policy = diskPolicy(dir);
  let cached = null;
  try {
    const read = JSON.parse(readFileSync(join(dir, CACHE_FILE), 'utf8'));
    if (Number.isFinite(read.at) && Array.isArray(read.stores)) cached = read;
  } catch { /* Never measured, or unreadable: measure. */ }
  if (!cached || now - cached.at < 0 || now - cached.at >= maxAgeMs) start(dir, { now });
  if (!cached) return { dir, total: null, stores: [], thresholdBytes: policy.warnBytes, warning: null, measuring: true };
  return { ...summarized(dir, cached.stores, policy), measuredAt: new Date(cached.at).toISOString() };
}

/** Human size such as 29.0 GB. */
export function sizeText(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** The lines status and stats print: each store, the total, and the warning when it applies. */
export function diskLines(use) {
  if (use.total === null) return ['disk use under .git/pullboard: being measured in the background; status shows it once measured'];
  const lines = [`disk use under .git/pullboard: ${sizeText(use.total)} total (${use.stores.map(row => `${row.name} ${sizeText(row.bytes)}`).join(', ') || 'empty'})`];
  if (use.warning) lines.push(`disk warning: .git/pullboard is ${sizeText(use.warning.totalBytes)}, over the ${sizeText(use.warning.thresholdBytes)} threshold; largest: ${use.warning.largest.join(', ')}; pullboard stats disk --prune ages out old raw logs and archives`);
  return lines;
}

/** Every word a receipt, ledger or landing record mentions, so a raw file they name is never removed. */
function referencedWords(dir) {
  const words = new Set();
  const take = (path) => {
    let stat;
    try { stat = lstatSync(path); } catch { return; }
    if (stat.isDirectory()) { let names = []; try { names = readdirSync(path); } catch { return; } for (const name of names) take(join(path, name)); return; }
    if (stat.size > 64 * 1024 * 1024) return;
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { return; }
    for (const word of text.match(/[A-Za-z0-9._-]{6,}/gu) ?? []) words.add(word);
  };
  for (const name of DISK_STORES.receipts) take(join(dir, name));
  for (const name of ['landings', 'main-audits', 'agent-evidence', 'review-packets', 'submit-handoffs']) take(join(dir, name));
  return words;
}

/**
 * Age out bulky raw material past its age or size limit, oldest first, logging each removal with what and why.
 * Receipts, ledger records and board rows are never candidates, and an entry a receipt names is kept.
 */
export function pruneDisk(dir, { now = Date.now(), dryRun = false } = {}) {
  const policy = diskPolicy(dir);
  const referenced = referencedWords(dir);
  const removed = [];
  const kept = [];
  for (const store of AGING_STORES) {
    const folder = join(dir, DISK_STORES[store][0]);
    let names = [];
    try { names = readdirSync(folder); } catch { continue; }
    const entries = names.map(name => {
      const path = join(folder, name);
      return { name, path, mtimeMs: newestMtime(path), bytes: bytesUnder(path), held: referenced.has(name) || referenced.has(name.replace(/\.[^.]+$/u, '')) };
    }).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const rule = policy.retention[store];
    let size = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries) {
      const ageDays = Math.floor((now - entry.mtimeMs) / DAY);
      const old = now - entry.mtimeMs > rule.maxAgeDays * DAY;
      const over = size > rule.maxBytes;
      if (!old && !over) continue;
      if (entry.held) { kept.push({ store, entry: entry.name, bytes: entry.bytes, reason: 'a receipt or record still references it' }); continue; }
      const reason = old ? `older than ${rule.maxAgeDays} days (${ageDays} days old)` : `store over its ${sizeText(rule.maxBytes)} limit`;
      if (!dryRun) {
        try { rmSync(entry.path, { recursive: true, force: true }); } catch (error) {
          // A runner wrote into the folder as it was removed (9 Nov: test-actions/lists): keep it, free nothing, go on.
          if (!REMOVAL_RACES.has(error?.code)) throw error;
          kept.push({ store, entry: entry.name, bytes: entry.bytes, reason: 'written to during removal; try again later' });
          continue;
        }
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, LOG_FILE), JSON.stringify({ at: new Date(now).toISOString(), store, entry: entry.name, bytes: entry.bytes, reason }) + '\n');
      }
      removed.push({ store, entry: entry.name, bytes: entry.bytes, reason });
      size -= entry.bytes;
    }
  }
  if (!dryRun && removed.length) rmSync(join(dir, CACHE_FILE), { force: true });
  return { removed, kept, freedBytes: removed.reduce((sum, row) => sum + row.bytes, 0), dryRun };
}

/** Lines describing a prune. */
export function pruneLines(result) {
  const lines = result.removed.map(row => `${result.dryRun ? 'would remove' : 'removed'} ${row.store}/${row.entry} (${sizeText(row.bytes)}): ${row.reason}`);
  for (const row of result.kept) lines.push(`kept ${row.store}/${row.entry} (${sizeText(row.bytes)}): ${row.reason}`);
  lines.push(`${result.dryRun ? 'would free' : 'freed'} ${sizeText(result.freedBytes)}`);
  return lines;
}

/** Run a disk read or prune, turning a bad policy file into the caller's Refused so the command names the next step. */
export function refusingBadPolicy(run, Refused) {
  try { return run(); } catch (error) {
    if (error?.code === 'DISK_POLICY_INVALID') throw new Refused('DISK_POLICY_INVALID', error.message);
    throw error;
  }
}
