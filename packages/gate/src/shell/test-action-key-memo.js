/** Immutable, per-file key memos: an unchanged tree reads only the requested key records [C7]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Name a selector without making its path part of a cache filesystem path. */
function name(file) { return createHash('sha256').update(file).digest('hex'); }

/** Detect a damaged memo record even when its altered key is still syntactically a hash. */
function checksum(identity, file, value) {
  return createHash('sha256').update(JSON.stringify({ identity, file, value })).digest('hex');
}

/** Publish one complete JSON value; another planner never sees a partially written record. */
function publish(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

const MEMO_MAX_AGE_MS = 2 * 3_600_000;
const PRUNE_EVERY_MS = 600_000;

/**
 * Remove key memo folders not read or written for 2 hours, at most once per 10 minutes per machine, the way
 * pruneRuns ages out run folders. A pruned memo simply rebuilds on its next use. Why: one ~4 MB memo per tested
 * tree filled the coordinator disk.
 *
 * @param {string} store
 * @param {number} [now]
 */
function pruneKeyMemos(store, now = Date.now()) {
  const keys = join(store, 'keys');
  const marker = join(keys, '.pruned');
  try { if (now - statSync(marker).mtimeMs < PRUNE_EVERY_MS) return; } catch { /* Never pruned: go on. */ }
  try { mkdirSync(keys, { recursive: true, mode: 0o700 }); writeFileSync(marker, ''); utimesSync(marker, new Date(now), new Date(now)); } catch { return; }
  let names = [];
  try { names = readdirSync(keys); } catch { return; }
  for (const folder of names) {
    try { if (now - statSync(join(keys, folder)).mtimeMs > MEMO_MAX_AGE_MS) rmSync(join(keys, folder), { recursive: true, force: true }); }
    catch { /* A folder another run removed first needs nothing more. */ }
  }
}

/**
 * Read the requested records of an immutable key plan, or compute it once on a cold tree.
 * The existing conservative graph builder still owns cold-tree cost; this memo does not claim
 * incremental graph construction. A missing, corrupt or mismatched record always rebuilds.
 *
 * @param {string} store
 * @param {string} identity committed tree, key algorithm, material options and execution context
 * @param {string[] | undefined} files undefined requests every known test, otherwise only these files
 * @param {() => Promise<Map<string, object>>} build
 * @returns {Promise<Map<string, object>>}
 */
export async function memoizedActionKeys(store, identity, files, build) {
  const directory = join(store, 'keys', identity);
  pruneKeyMemos(store);
  try {
    const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8'));
    if (index.identity !== identity) throw new Error('invalid key memo');
    // Explicit selections do not even parse the all-tests catalog.
    const selected = files ?? JSON.parse(readFileSync(join(directory, 'files.json'), 'utf8'));
    if (!Array.isArray(selected) || selected.some(file => typeof file !== 'string')) throw new Error('invalid key catalog');
    const keys = new Map();
    for (const file of selected) {
      const record = JSON.parse(readFileSync(join(directory, `${name(file)}.json`), 'utf8'));
      if (record.identity !== identity || record.file !== file
        || record.checksum !== checksum(identity, file, record.value)
        || !(record.value?.key === null || /^[0-9a-f]{64}$/u.test(record.value?.key)) || typeof record.value.reason !== 'string') throw new Error('invalid key record');
      keys.set(file, record.value);
    }
    try { const now = new Date(); utimesSync(directory, now, now); } catch { /* Age is best effort. */ }
    return keys;
  } catch { /* A cold or unverifiable memo uses the ordinary conservative graph builder. */ }
  const keys = await build();
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [file, value] of keys) publish(join(directory, `${name(file)}.json`), { identity, file, value, checksum: checksum(identity, file, value) });
    publish(join(directory, 'files.json'), [...keys.keys()]);
    publish(join(directory, 'index.json'), { identity });
  } catch { /* Storage is an optimization; the freshly computed keys remain usable. */ }
  return files ? new Map(files.filter(file => keys.has(file)).map(file => [file, keys.get(file)])) : keys;
}
