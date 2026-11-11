/** Test-action parts and shared file lists are pruned by age and to a size cap, never a record a key or receipt still names [C7]. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { REFERENCE_PARTS } from '../account.js';

export const PARTS_CAP_BYTES = 10 * 1024 ** 3;
export const PARTS_MAX_AGE_MS = 24 * 60 * 60_000;
const HASH = /^[0-9a-f]{64}$/u;
const GRACE_MS = 10 * 60_000;
const INTERVAL_MS = 10 * 60_000;

/** Read one JSON file, or null when it is missing or unreadable. */
function load(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** The file names in a folder, or none when it does not exist. */
function names(directory) {
  try { return readdirSync(directory); } catch { return []; }
}

/** The result rows a retained completion carries: a packed packet (base64 gzip of rows), or the rows themselves. */
function completionRows(packet) {
  try {
    const rows = typeof packet === 'string'
      ? JSON.parse(gunzipSync(Buffer.from(packet, 'base64'), { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8'))
      : packet;
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

/**
 * Every input key a current record names: key memos (their per-file values), green and red result records, each
 * file's latest-key record, and the result rows of every retained runner completion (a completion whose import failed
 * is the only reference left to its parts). A part named by none of them can no longer explain a miss or back a reuse.
 *
 * @param {string} store the test-action store
 * @returns {Set<string>}
 */
export function namedInputKeys(store) {
  const named = new Set();
  /** Add a record's input key when it has one. */
  const add = (record) => {
    const key = record?.inputKey ?? record?.value?.inputKey;
    if (typeof key === 'string' && HASH.test(key)) named.add(key);
  };
  for (const identity of names(join(store, 'keys'))) {
    for (const file of names(join(store, 'keys', identity))) if (file.endsWith('.json')) add(load(join(store, 'keys', identity, file)));
  }
  for (const folder of ['green', 'red', 'last']) {
    for (const file of names(join(store, folder))) add(load(join(store, folder, file)));
  }
  for (const file of names(join(store, 'completions'))) {
    for (const row of completionRows(load(join(store, 'completions', file))?.testResults)) add(row);
  }
  return named;
}

/**
 * Remove parts no record names, then shared file lists no remaining part names: every such record older than the age
 * cap, then the rest oldest first until the parts and lists together fit under the size cap. A record younger than the
 * grace period is kept: its run may not have been named yet. A named record is never removed, whatever its age.
 *
 * @param {string} store the test-action store
 * @param {{ capBytes?: number, maxAgeMs?: number, graceMs?: number, now?: number }} [options]
 * @returns {{ removedParts: number, removedLists: number, bytes: number }} what was removed and the size left
 */
export function prunePartsStore(store, { capBytes = PARTS_CAP_BYTES, maxAgeMs = PARTS_MAX_AGE_MS, graceMs = GRACE_MS, now = Date.now() } = {}) {
  const listsDirectory = join(store, 'lists');
  /** Size and age of every record in a folder, tagged with the folder. */
  const scan = (directory) => names(directory).flatMap(file => {
    try { const stat = statSync(join(directory, file)); return [{ file, path: join(directory, file), size: stat.size, at: stat.mtimeMs, by: directory }]; }
    catch { return []; }
  });
  // Inline parts (an older writer's, under parts) and by-reference parts (under parts-ref) are pruned alike.
  const parts = [...scan(join(store, 'parts')), ...scan(join(store, REFERENCE_PARTS))], lists = scan(listsDirectory);
  let bytes = [...parts, ...lists].reduce((sum, row) => sum + row.size, 0);
  const named = namedInputKeys(store);
  let removedParts = 0, removedLists = 0;
  /** Remove one record and its size from the total. */
  const drop = (row) => { try { rmSync(row.path, { force: true }); bytes -= row.size; return true; } catch { return false; } };
  /** Whether an unnamed record goes now: past the age cap, or the store is still over the size cap. */
  const due = (row) => now - row.at >= Math.max(graceMs, maxAgeMs) || bytes > capBytes;
  const unnamedParts = parts.filter(row => !named.has(row.file.replace(/\.json$/u, '')) && now - row.at >= graceMs).sort((a, b) => a.at - b.at);
  const gone = new Set();
  for (const row of unnamedParts) {
    if (!due(row)) continue;
    if (drop(row)) { removedParts += 1; gone.add(row.path); }
  }
  if (bytes > capBytes || lists.some(row => now - row.at >= Math.max(graceMs, maxAgeMs))) {
    const used = new Set();
    for (const row of parts) {
      if (gone.has(row.path)) continue;
      const part = load(row.path);
      for (const value of [part?.files, part?.runner]) if (typeof value === 'string') used.add(value);
    }
    for (const row of lists.filter(row => !used.has(row.file.replace(/\.json$/u, '')) && now - row.at >= graceMs).sort((a, b) => a.at - b.at)) {
      if (!due(row)) continue;
      if (drop(row)) removedLists += 1;
    }
  }
  return { removedParts, removedLists, bytes };
}

/**
 * Routine maintenance entry: prune at most once per ten minutes per store, under a configurable size cap
 * (PULLBOARD_TEST_PARTS_CAP_BYTES, default 10 GB) and age cap (PULLBOARD_TEST_PARTS_MAX_AGE_MS, default 24 hours).
 * A failure here never changes whether a test runs.
 *
 * @param {string} store the test-action store
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ removedParts: number, removedLists: number, bytes: number } | null} null when throttled or on failure
 */
export function maintainPartsStore(store, env = process.env) {
  try {
    const marker = join(store, 'parts-prune');
    const at = Date.now();
    try { if (at - statSync(marker).mtimeMs < INTERVAL_MS) return null; } catch { /* Never pruned. */ }
    mkdirSync(store, { recursive: true, mode: 0o700 });
    if (existsSync(marker)) utimesSync(marker, new Date(at), new Date(at)); else writeFileSync(marker, '', { mode: 0o600 });
    /** A positive configured number, or the default. */
    const setting = (value, fallback) => { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; };
    return prunePartsStore(store, {
      capBytes: setting(env.PULLBOARD_TEST_PARTS_CAP_BYTES, PARTS_CAP_BYTES),
      maxAgeMs: setting(env.PULLBOARD_TEST_PARTS_MAX_AGE_MS, PARTS_MAX_AGE_MS),
    });
  } catch { return null; }
}
