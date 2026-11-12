/** A pull runner prunes old test results and dead job environment folders by age and a disk floor, each serve cycle [P7]. */
import { lstatSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statfsSync } from 'node:fs';
import { join } from 'node:path';

const GIB = 1024 ** 3;
export const PRUNE_MAX_AGE_MS = 24 * 60 * 60_000;
export const PRUNE_INTERVAL_MS = 10 * 60_000;
/** A folder changed this recently may belong to another serve sharing the cache, so it is kept. */
const GRACE_MS = 10 * 60_000;
/** Extra free space kept above the archive guard's reserve, so the guard never trips between cycles. */
const MARGIN_BYTES = 2 * GIB;

/** The names in a folder, or none when it does not exist. */
function names(directory) {
  try { return readdirSync(directory); } catch { return []; }
}

/** Bytes under a path without following links, and the newest modification time anywhere beneath it. */
function measure(path) {
  let stat;
  try { stat = lstatSync(path); } catch { return { bytes: 0, at: 0 }; }
  let bytes = stat.blocks * 512, at = stat.mtimeMs;
  if (stat.isDirectory()) {
    for (const name of names(path)) { const inner = measure(join(path, name)); bytes += inner.bytes; at = Math.max(at, inner.at); }
  }
  return { bytes, at };
}

/**
 * Free and total bytes of the volume holding a path; null when it cannot be read.
 * @param {string} path
 * @returns {{ freeBytes: number, totalBytes: number } | null}
 */
export function volumeSpace(path) {
  try { const s = statfsSync(path); return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }; } catch { return null; }
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

/**
 * Remove test-results records and pull job environment folders that are old, then the oldest of what remains while free
 * disk is below the floor. Test-results units are the input buckets and green records under each repo store; environment
 * folders are <cache>/env/<name>. A folder named in `live` (a running job) is never removed, nor one changed within the grace.
 *
 * @param {{ root: string, cache: string, live?: Set<string>, maxAgeMs?: number, floorBytes?: number, graceMs?: number, now?: number, space?: () => ({ freeBytes: number, totalBytes: number } | null) }} options
 *   root: the runner root holding test-results; cache: the pull cache holding env; space: free-space reader, injectable.
 * @returns {{ removed: string[], freeBytes: number | null }} paths removed and the free bytes afterwards
 */
export function pruneRunnerStores({ root, cache, live = new Set(), maxAgeMs = PRUNE_MAX_AGE_MS, floorBytes, graceMs = GRACE_MS, now = Date.now(), space = () => volumeSpace(root) }) {
  const units = [];
  const store = join(root, 'test-results');
  for (const repo of names(store)) {
    if (repo.startsWith('.')) continue;
    for (const folder of ['inputs', 'green']) {
      for (const name of names(join(store, repo, folder))) { const path = join(store, repo, folder, name); units.push({ path, ...measure(path) }); }
    }
  }
  for (const name of names(join(cache, 'env'))) {
    if (live.has(name)) continue;
    const path = join(cache, 'env', name);
    units.push({ path, ...measure(path) });
  }
  const removed = [];
  let reading = space();
  let free = reading?.freeBytes ?? null;
  const floor = floorBytes ?? (reading ? defaultFloorBytes(reading.totalBytes) : null);
  for (const unit of units.sort((a, b) => a.at - b.at)) {
    if (now - unit.at < graceMs) continue;
    const old = now - unit.at >= maxAgeMs, short = free !== null && floor !== null && free < floor;
    if (!old && !short) continue;
    try { rmSync(unit.path, { recursive: true, force: true }); } catch { continue; }
    removed.push(unit.path);
    if (free !== null) free += unit.bytes;
  }
  return { removed, freeBytes: free };
}
