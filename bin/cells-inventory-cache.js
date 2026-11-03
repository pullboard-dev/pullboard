/** Cache immutable base inventories on the machine and incrementally inspect a candidate [C7,D3]. */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { deserialize } from 'node:v8';
import { gzipSync } from 'node:zlib';
import { gunzipSync } from 'node:zlib';
import { cellInventory } from '../packages/codemap/index.js';
import { updateCellInventory } from '../packages/codemap/index.js';
import { needsFullCensus } from '../packages/codemap/index.js';
import { machineHome } from '../packages/resources/index.js';
import { receiptDigest } from '../packages/git/index.js';
import { git } from '../src/git.js';
import { Refused } from '../packages/kernel/index.js';

/** A cache is never evidence for a moved or dirty immutable source. */
function unchanged(checkout, commit) {
  if (git(checkout, ['rev-parse', 'HEAD']) !== commit || git(checkout, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Refused('CELLS_SUBMIT', 'immutable analysis snapshot changed during inspection');
  }
}

/** How many inventories or observation sets one machine keeps per kind; older entries leave by last use. */
const KEEP = 24;

/**
 * The machine-level folder for one kind of cells cache. Why the machine and not the checkout's Git directory: every
 * runner job is a fresh checkout, so a cache beside it never survived to the next job and each gate rebuilt main's
 * whole inventory (#2531). Entries are keyed by commit and checker digest, so repositories and jobs share safely.
 */
export function cellsCacheDirectory(kind) { return join(machineHome(), 'cells-cache', kind); }

/** The exact file holding one base inventory for a commit under a checker key, or null without a key. */
export function inventoryCacheFile(key, commit) {
  if (!key) return null;
  const checker = receiptDigest({ definition: key.checkDigest, preloads: key.config?.preloads });
  return join(cellsCacheDirectory('inventory'), `${receiptDigest({ commit, checker })}.json.gz`);
}

/** Mark a cache entry used now, so pruning keeps the bases that gates still read. */
function touch(file) {
  try { const now = new Date(); utimesSync(file, now, now); } catch { /* Use order is advisory. */ }
}

/** Atomically publish one cache entry, then keep only the most recently used entries of its kind. */
function publish(directory, file, bytes) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  try {
    const entries = readdirSync(directory).filter(name => name.endsWith('.json.gz')).map(name => {
      try { return { name, used: statSync(join(directory, name)).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.used - a.used);
    for (const entry of entries.slice(KEEP)) rmSync(join(directory, entry.name), { force: true });
  } catch { /* Pruning failure only costs disk until the next write. */ }
}

/** Share only complete immutable inventories under their exact commit and checker identity. */
export function inventoryCache(root, key, parsers, onMode = () => {}, eligible = () => true) {
  const memory = new Map();
  const checker = key ? receiptDigest({ definition: key.checkDigest, preloads: key.config?.preloads }) : null;
  /** Read or construct the pinned base once; a malformed cache is never evidence. */
  function base(checkout, commit) {
    unchanged(checkout, commit);
    if (memory.has(commit)) return memory.get(commit);
    const directory = cellsCacheDirectory('inventory');
    const file = inventoryCacheFile(key, commit);
    let inventory;
    if (file && eligible()) try {
      const data = deserialize(gunzipSync(readFileSync(file), { maxOutputLength: 256 * 1024 * 1024 }));
      if (data.version !== 2 || data.commit !== commit || data.checker !== checker || !Buffer.isBuffer(data.payload)
        || data.digest !== createHash('sha256').update(data.payload).digest('hex')) throw new Error('invalid inventory cache');
      inventory = deserialize(data.payload);
      if (!(inventory.files instanceof Map) || !(inventory.edges instanceof Map) || !Array.isArray(inventory.unknown)
        || [...inventory.files].some(([path, bytes]) => typeof path !== 'string' || !Buffer.isBuffer(bytes))
        || [...inventory.edges].some(([path, rows]) => typeof path !== 'string' || !Array.isArray(rows))
        || inventory.unknown.some(row => !row || typeof row.file !== 'string')) throw new Error('invalid inventory cache');
      if (!eligible()) throw new Error('preload changed');
      unchanged(checkout, commit);
      touch(file);
      onMode('base-cache');
    } catch { /* Missing or damaged evidence requires a fresh immutable census. */ }
    if (!inventory) {
      onMode('base-full');
      inventory = cellInventory(checkout, parsers);
      unchanged(checkout, commit);
      if (file && eligible()) try {
        const payload = serialize(inventory);
        const data = { version: 2, commit, checker, digest: createHash('sha256').update(payload).digest('hex'), payload };
        if (!eligible()) throw new Error('preload changed');
        publish(directory, file, gzipSync(serialize(data)));
      } catch { /* A cache write failure only costs a later census. */ }
    }
    memory.set(commit, inventory);
    return inventory;
  }
  /** Update only the changed, added and deleted paths; package.json, the kernel front door and discovery.js keep the full census. */
  function candidate(checkout, prior, changed) {
    const fallback = needsFullCensus(changed);
    onMode(fallback ? 'candidate-full-fallback' : 'candidate-incremental');
    return fallback ? cellInventory(checkout, parsers) : updateCellInventory(checkout, parsers, prior, changed);
  }
  return { base, candidate };
}

/** Persist only complete compiler and lexical observations from checked immutable snapshots. */
export function observationCache(root, key, eligible = () => false) {
  const directory = cellsCacheDirectory('observations');
  const checker = key ? receiptDigest({ definition: key.checkDigest, preloads: key.config?.preloads }) : null;
  const file = key ? join(directory, `${receiptDigest({ commit: key.config.acceptedMain, checker })}.json.gz`) : null;
  let values = new Map();
  if (file && eligible()) try {
    const data = JSON.parse(gunzipSync(readFileSync(file), { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8'));
    if (data.version !== 1 || data.checker !== checker || data.commit !== key.config.acceptedMain
      || data.digest !== receiptDigest(data.payload)) throw new Error('invalid observations');
    const loaded = deserialize(Buffer.from(data.payload, 'base64'));
    if (!(loaded instanceof Map) || loaded.size > 32768 || [...loaded].some(([id, row]) => typeof id !== 'string'
      || !row || !Number.isSafeInteger(row.bytes) || row.bytes < 0) || !eligible()) throw new Error('invalid observation entries');
    if ([...loaded.values()].reduce((sum, row) => sum + row.bytes, 0) > 128 * 1024 * 1024) throw new Error('oversized observations');
    values = loaded;
    touch(file);
  } catch { /* Missing or invalid cache leaves observations empty. */ }
  /** Publish the observations gathered this run; an ineligible or failed write only costs a later run. */
  function commit() {
    if (!file || !eligible()) return;
    try {
      const payload = serialize(values).toString('base64');
      const data = { version: 1, checker, commit: key.config.acceptedMain, digest: receiptDigest(payload), payload };
      if (!eligible()) return;
      publish(directory, file, gzipSync(Buffer.from(JSON.stringify(data))));
    } catch { /* Optional observations never replace a real analysis. */ }
  }
  return { values, commit };
}
