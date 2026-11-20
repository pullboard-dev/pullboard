/** A pull runner prunes old test results and dead job environment folders by age and a disk floor, each serve cycle [P7]. */
import { fileSystemAdapter } from '../../../fs/index.js';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The file system every read and write in this file goes through, so a test can hand a fake one [C7]. */
const disk = fileSystemAdapter();

const GIB = 1024 ** 3;
export const PRUNE_MAX_AGE_MS = 24 * 60 * 60_000;
export const PRUNE_INTERVAL_MS = 10 * 60_000;
// Budget: a yielding prune runs 20 ms between hand-backs, far under the 30 s a lease is renewed, and the walk costs a few percent more than a blocking one.
const SLICE_MS = 20;
/** A folder changed this recently may belong to another serve sharing the cache, so it is kept. */
const GRACE_MS = 10 * 60_000;
/** Extra free space kept above the archive guard's reserve, so the guard never trips between cycles. */
const MARGIN_BYTES = 2 * GIB;

/** The names in a folder, or none when it does not exist. */
function names(directory) {
  try { return disk.list(directory); } catch { return []; }
}

/**
 * Bytes under a path without following links, and the newest modification time anywhere beneath it. It yields before
 * each entry it reads, so a caller may give the event loop back between steps (#9025).
 */
function* measureSteps(path) {
  let stat;
  try { stat = disk.lstat(path); } catch { return { bytes: 0, at: 0 }; }
  let bytes = stat.blocks * 512, at = stat.mtimeMs;
  if (stat.isDirectory()) {
    for (const name of names(path)) { yield; const inner = yield* measureSteps(join(path, name)); bytes += inner.bytes; at = Math.max(at, inner.at); }
  }
  return { bytes, at };
}

/**
 * Free and total bytes of the volume holding a path; null when it cannot be read.
 * @param {string} path
 * @returns {{ freeBytes: number, totalBytes: number } | null}
 */
export function volumeSpace(path) {
  try { const s = disk.statfs(path); return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }; } catch { return null; }
}

/**
 * The free space a runner keeps: the archive guard's reserve (the larger of 10 GiB and 5% of the volume) plus a margin.
 * Why the guard's number: ARCHIVE_WOULD_FILL_DISK refuses an archive when free space would fall below it.
 * @param {number} totalBytes
 * @returns {number}
 */
export function defaultFloorBytes(totalBytes) {
  return Math.ceil(Math.max(10 * GIB, totalBytes * 0.05)) + MARGIN_BYTES;
}

/** Chrome's own temp folders in a temp directory are dead an hour after their last change, so a runner prune removes them [C7]. */
const CHROME_TEMP = /^(com\.google\.Chrome|org\.chromium\.Chromium)/u;
const CHROME_TEMP_MAX_AGE_MS = 60 * 60_000;

/**
 * Remove Chrome temp folders (com.google.Chrome*, org.chromium.Chromium*) in `dir` that are older than an hour. Why: a
 * browser test killed mid-run leaves them behind and they filled runner disks.
 *
 * @param {{ dir?: string, maxAgeMs?: number, now?: number }} options
 * @returns {string[]} the paths removed
 */
export function pruneChromeTemp({ dir = tmpdir(), maxAgeMs = CHROME_TEMP_MAX_AGE_MS, now = Date.now() } = {}) {
  const removed = [];
  for (const name of names(dir)) {
    if (!CHROME_TEMP.test(name)) continue;
    const path = join(dir, name);
    if (now - touched(path) < maxAgeMs) continue;
    try { disk.rm(path, { recursive: true, force: true }); removed.push(path); } catch { /* best effort */ }
  }
  return removed;
}

/**
 * Remove test-results records and pull job environment folders that are old, then the oldest of what remains while free
 * disk is below the floor. Test-results units are the input buckets and green records under each repo store; environment
 * folders are <cache>/env/<name>. A folder named in `live` (a running job) is never removed, nor one changed within the grace.
 *
 * @param {{ root: string, cache: string, live?: Set<string>, maxAgeMs?: number, floorBytes?: number, graceMs?: number, now?: number, space?: () => ({ freeBytes: number, totalBytes: number } | null) }} options
 *   root: the runner root holding test-results; cache: the pull cache holding env; space: free-space reader, injectable.
 * @returns {{ removed: string[], freeBytes: number | null }} paths removed and the free bytes afterwards
 */
export function pruneRunnerStores(options) {
  const steps = pruneSteps(options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/**
 * pruneRunnerStores for a serve that holds leases: the same walk and the same result, but it gives the event loop back
 * every few milliseconds, so lease renewals, claims and receipts keep running while it measures.
 * Why: on 16 Nov the synchronous walk of 327,000 files under a loaded disk stopped two runners' event loops for about two
 * minutes, every held lease lapsed, and 14 census jobs ended with no receipt and no released step (#9025).
 *
 * @param {Parameters<typeof pruneRunnerStores>[0]} options
 * @param {{ sliceMs?: number }} [timing] - sliceMs: how long the walk runs before it yields.
 * @returns {Promise<{ removed: string[], freeBytes: number | null }>}
 */
export async function pruneRunnerStoresYielding(options, { sliceMs = SLICE_MS } = {}) {
  const steps = pruneSteps(options);
  let sliceEnd = Date.now() + sliceMs;
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (Date.now() >= sliceEnd) { await new Promise(resolve => setImmediate(resolve)); sliceEnd = Date.now() + sliceMs; }
  }
}

/** The prune as steps: each yield is a safe place to hand the event loop back. */
function* pruneSteps({ root, cache, live = new Set(), maxAgeMs = PRUNE_MAX_AGE_MS, floorBytes, graceMs = GRACE_MS, now = Date.now(), space = () => volumeSpace(root), tmp = tmpdir() }) {
  const units = [];
  const removedChrome = pruneChromeTemp({ dir: tmp, now });
  const store = join(root, 'test-results');
  for (const repo of names(store)) {
    if (repo.startsWith('.')) continue;
    for (const folder of ['inputs', 'green']) {
      for (const name of names(join(store, repo, folder))) { const path = join(store, repo, folder, name); units.push({ path, ...(yield* measureSteps(path)) }); }
    }
  }
  for (const name of names(join(cache, 'env'))) {
    if (live.has(name)) continue;
    const path = join(cache, 'env', name);
    units.push({ path, env: name, ...(yield* measureSteps(path)) });
  }
  const removed = [...removedChrome];
  let reading = space();
  let free = reading?.freeBytes ?? null;
  const floor = floorBytes ?? (reading ? defaultFloorBytes(reading.totalBytes) : null);
  for (const unit of units.sort((a, b) => a.at - b.at)) {
    yield;
    if (now - unit.at < graceMs) continue;
    // A job that began while the walk ran owns its folder now, so the walk leaves it.
    if (unit.env !== undefined && live.has(unit.env)) continue;
    const old = now - unit.at >= maxAgeMs, short = free !== null && floor !== null && free < floor;
    if (!old && !short) continue;
    try { disk.rm(unit.path, { recursive: true, force: true }); } catch { continue; }
    removed.push(unit.path);
    if (free !== null) free += unit.bytes;
  }
  return { removed, freeBytes: free };
}

/** A slot folder of one serve instance: runner-<instance id>-<slot number>. */
const SLOT = /^runner-.+-\d+$/u;

/** The newest modification time of a folder and its direct entries; a shallow read, since a slot can hold gigabytes. */
function touched(path) {
  let at = 0;
  try { at = disk.lstat(path).mtimeMs; } catch { return 0; }
  for (const name of names(path)) { try { at = Math.max(at, disk.lstat(join(path, name)).mtimeMs); } catch { /* gone meanwhile */ } }
  return at;
}

/**
 * Remove the slot folders under <cache>/main and <cache>/work that belong to other serve instances, keeping the current
 * instance's. Why: each serve restart takes a new instance id, and its checkouts were left behind, about 55 GB per runner.
 * A folder changed within the grace is kept, since another serve sharing the cache may be running a job in it.
 *
 * @param {{ cache: string, instance: string, graceMs?: number, now?: number }} options
 *   instance: the current serve's slot folder prefix, runner-<id>; its slots are <instance>-<n>.
 * @returns {Promise<string[]>} the paths removed
 */
export async function pruneStaleSlots({ cache, instance, graceMs = GRACE_MS, now = Date.now() }) {
  const own = new RegExp(`^${instance.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-\\d+$`, 'u');
  const removed = [];
  for (const parent of ['main', 'work']) {
    for (const name of names(join(cache, parent))) {
      if (!SLOT.test(name) || own.test(name)) continue;
      const path = join(cache, parent, name);
      if (now - touched(path) < graceMs) continue;
      try { await disk.promises.rm(path, { recursive: true, force: true }); removed.push(path); } catch { /* best effort */ }
    }
  }
  return removed;
}

/** Slot-folder prefixes a serve in this process holds now. */
const HELD = new Set();

/** Whether a process id names a live process. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * Take the slot-folder prefix runner-<host> for one live serve, so a restart finds its slot folders (and the warm
 * trees and test-action caches in them) under the same names. Why a lock: one live serve per slot folder, so a second
 * serve on the same host and cache, or a dead serve's leftover claim, never lets two serves share a checkout. The
 * holder is a pid file under <cache>/slots; a dead holder's file is taken over, since its folders are then adoptable
 * (the checkout step verifies and resets each before use). A host whose prefix is held gets a unique one instead.
 *
 * @param {{ cache: string, host: string }} options
 * @returns {{ prefix: string, release: () => void, shared?: boolean }} the slot-folder prefix and how to give it back; shared when another serve holds the host prefix
 */
export function claimSlotPrefix({ cache, host }) {
  const prefix = `runner-${host}`, file = join(cache, 'slots', `${prefix}.pid`), mine = `${process.pid}:${randomBytes(4).toString('hex')}`;
  const none = { prefix: `${prefix}-${randomBytes(3).toString('hex')}`, release: () => {}, shared: true };
  try {
    disk.mkdir(join(cache, 'slots'), { recursive: true });
    if (HELD.has(prefix)) return none;
    let holder = '';
    try { holder = disk.readFile(file, 'utf8'); } catch { /* no holder */ }
    const pid = Number(holder.split(':')[0]);
    if (holder && Number.isInteger(pid) && pid !== process.pid && alive(pid)) return none;
    disk.writeFile(file, mine);
    if (disk.readFile(file, 'utf8') !== mine) return none;
  } catch { return none; }
  HELD.add(prefix);
  return { prefix, release: () => { HELD.delete(prefix); try { if (disk.readFile(file, 'utf8') === mine) disk.rm(file, { force: true }); } catch { /* gone */ } } };
}
