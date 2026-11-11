/**
 * Read the agents' own session logs, Claude transcripts and Codex rollouts, into activity segments and token buckets
 * for the pipeline ledger [C7,N2]. Read only: the logs are never written. A keyed store the caller passes in keeps each
 * file's fold and the byte offset it reached, so a later read parses only what the file gained since.
 */
import { closeSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KEEP_MS } from '../logic/activity.js';
import { foldText } from '../logic/activity.js';
import { newFold } from '../logic/activity.js';
import { openTail } from '../logic/activity.js';

/** Version of a cached fold; a different version is refolded from the start. */
const CACHE_VERSION = 2;

/** Bytes read per chunk, so a rollout of hundreds of megabytes never becomes one string. */
const CHUNK = 8 * 1024 * 1024;

/**
 * The folder name Claude Code gives a project: its path with every character outside [A-Za-z0-9] made a hyphen.
 *
 * @param {string} path
 * @returns {string}
 */
export function claudeProjectName(path) {
  return String(path).replace(/[^A-Za-z0-9]/gu, '-');
}

/**
 * Every .jsonl file under a folder, to a depth, changed at or after `since`.
 *
 * @param {string} folder
 * @param {number} since
 * @param {number} depth
 * @param {(name: string) => boolean} [take] - which top-level entries to enter
 * @returns {{ file: string, size: number, mtimeMs: number, ino: number }[]}
 */
function logFiles(folder, since, depth, take = () => true) {
  const found = [];
  const walk = (dir, level, top) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (top && !take(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (level < depth) walk(path, level + 1, false); continue; }
      if (!entry.name.endsWith('.jsonl')) continue;
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.mtimeMs >= since) found.push({ file: path, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
    }
  };
  walk(folder, 0, true);
  return found;
}

/**
 * The session files that could hold activity in the window: Claude projects named for this repository or a folder
 * beside it, with each session's subagent transcripts (`<session>/subagents/*.jsonl`), and every Codex rollout (filtered by working folder after reading).
 *
 * @param {{ root: string, since: number, home?: string }} options
 * @returns {{ file: string, provider: string, size: number, mtimeMs: number, ino: number }[]}
 */
export function sessionFiles({ root, since, home = homedir() }) {
  const prefix = claudeProjectName(root);
  const claude = logFiles(join(home, '.claude', 'projects'), since, 3, name => name.startsWith(prefix)).map(row => ({ ...row, provider: 'claude' }));
  const codex = logFiles(join(home, '.codex', 'sessions'), since, 4).map(row => ({ ...row, provider: 'codex' }));
  return [...claude, ...codex];
}

/**
 * The keyed store a caller hands in for folds: the CLI builds it from the pin cell's keyed results, so this cell
 * never writes a file of its own.
 *
 * @typedef {{ load: (key: string) => Uint8Array|null, save: (key: string, bytes: Uint8Array) => void }} SessionCache
 */

/**
 * Read one cached fold, or null when there is none, it is for another file, or the file shrank or was replaced.
 *
 * @param {SessionCache|null} cache
 * @param {{ file: string, ino: number, size: number }} source
 * @returns {object|null}
 */
function cached(cache, source) {
  if (!cache) return null;
  try {
    const value = JSON.parse(cache.load(source.file)?.toString('utf8') ?? 'null');
    if (value.v !== CACHE_VERSION || value.file !== source.file || value.ino !== source.ino || value.offset > source.size) return null;
    return value;
  } catch { return null; }
}

/**
 * Fold the bytes a session file gained since its cached offset, chunk by chunk, up to its last whole line.
 *
 * @param {object} source
 * @param {object} fold - the cached fold, advanced in place
 * @returns {boolean} whether anything was read
 */
function advance(source, fold) {
  if (fold.offset >= source.size) return false;
  let fd;
  try { fd = openSync(source.file, 'r'); } catch { return false; }
  try {
    let position = fold.offset, carry = Buffer.alloc(0);
    const out = { segments: fold.segments, buckets: fold.buckets };
    while (position < source.size) {
      const length = Math.min(CHUNK, source.size - position);
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, position);
      if (read <= 0) break;
      position += read;
      const bytes = carry.length ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
      const cut = bytes.lastIndexOf(0x0a);
      if (cut < 0) { carry = Buffer.from(bytes); continue; }
      foldText(fold.state, bytes.toString('utf8', 0, cut + 1), out);
      // The offset stops after the last whole line; a torn tail is read again next time.
      fold.offset = position - (bytes.length - cut - 1);
      carry = Buffer.from(bytes.subarray(cut + 1));
    }
    return true;
  } finally { closeSync(fd); }
}

/**
 * Save a fold as a result keyed by its session file, whole or not at all; a failure only costs the next read a refold.
 *
 * @param {SessionCache|null} cache
 * @param {object} fold
 */
function store(cache, fold) {
  if (!cache) return;
  try { cache.save(fold.file, Buffer.from(JSON.stringify(fold))); }
  catch { /* The cache is an accelerator; the ledger stands without it. */ }
}

/**
 * Every session's activity segments and token buckets in [since, now], from the cache plus whatever the logs gained.
 *
 * @param {object} options
 * @param {string} options.root - the repository's main checkout
 * @param {SessionCache|null} [options.cache] - where folds persist between reads; none refolds every time
 * @param {number} options.since
 * @param {number} options.now
 * @param {(cwd: string|null) => boolean} options.keep - which working folders belong to this repository
 * @param {string} [options.home]
 * @returns {{ segments: object[], buckets: object[], parsed: number }} parsed counts the files that gained bytes
 */
export function readSessions({ root, since, now, keep, home, cache = null }) {
  const segments = [], buckets = [];
  let parsed = 0;
  for (const source of sessionFiles({ root, since, home })) {
    const fold = cached(cache, source) ?? { v: CACHE_VERSION, file: source.file, ino: source.ino, offset: 0, state: newFold(source.provider), segments: [], buckets: [] };
    if (advance(source, fold)) {
      parsed += 1;
      const oldest = now - KEEP_MS;
      fold.segments = fold.segments.filter(segment => segment.e >= oldest);
      fold.buckets = fold.buckets.filter(bucket => bucket.t >= oldest && (bucket.fresh || bucket.read || bucket.write || bucket.out));
      store(cache, fold);
    }
    const wanted = source.provider === 'claude' ? () => true : keep;
    for (const segment of [...fold.segments, ...openTail(fold.state, now)]) if (segment.e >= since && segment.s <= now && wanted(segment.c)) segments.push(segment);
    for (const bucket of fold.buckets) if (bucket.t >= since - 15_000 && bucket.t <= now && wanted(bucket.c)) buckets.push(bucket);
  }
  return { segments, buckets, parsed };
}
