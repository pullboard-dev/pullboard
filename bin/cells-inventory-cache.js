/** Cache immutable base inventories on the machine and incrementally inspect a candidate [C7,D3]. */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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
import { checkCommandDefinition } from '../packages/git/index.js';
import { fileURLToPath } from 'node:url';
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

/** How far back along main's first parents a missing base looks for a cached inventory to update. */
const ANCESTORS = 200;

/**
 * The machine-level folder for one kind of cells cache. Why the machine and not the checkout's Git directory: every
 * runner job is a fresh checkout, so a cache beside it never survived to the next job and each gate rebuilt main's
 * whole inventory (#2531). Entries are keyed by commit and checker digest, so repositories and jobs share safely.
 */
export function cellsCacheDirectory(kind) { return join(machineHome(), 'cells-cache', kind); }

/** The modules whose code decides an inventory's content: the census, its incremental update and the import parsers. */
const INVENTORY_CODE = ['../packages/codemap/src/shell/cell-lint-inventory.js', '../packages/gate/src/shell/module-imports.js', './cells-inventory-cache.js']
  .map(path => fileURLToPath(new URL(path, import.meta.url)));
let inventoryCode;

/**
 * The digest of the inventory code's bytes, by path inside this tool. Why not the submit check's own key: that key
 * also covers unrelated checker files and names files by absolute path, and a runner runs main's tools from a fresh
 * temporary folder per job, so it changed every job and no inventory was ever found again (#2601).
 */
function inventoryCodeDigest() {
  inventoryCode ??= receiptDigest({ node: process.version,
    files: checkCommandDefinition(fileURLToPath(new URL('..', import.meta.url)), [], INVENTORY_CODE).map(file => [file.path, file.mode, file.digest]) });
  return inventoryCode;
}

/** The checker identity an inventory is cached under, or null without a key. */
function inventoryChecker(key) {
  return key ? receiptDigest({ inventory: inventoryCodeDigest(), preloads: key.config?.preloads }) : null;
}

/** The exact file holding one base inventory for a commit under a checker key, or null without a key. */
export function inventoryCacheFile(key, commit) {
  if (!key) return null;
  return join(cellsCacheDirectory('inventory'), `${receiptDigest({ commit, checker: inventoryChecker(key) })}.json.gz`);
}

/** Mark a cache entry used now, so pruning keeps the bases that gates still read. */
function touch(file) {
  try { const now = new Date(); utimesSync(file, now, now); } catch { /* Use order is advisory. */ }
}

/** Atomically publish one cache entry, then keep only the most recently used entries of its kind. */
export function publishCacheEntry(directory, file, bytes) {
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
  const checker = inventoryChecker(key);
  /** Read or construct the pinned base once; a malformed cache is never evidence. */
  function base(checkout, commit) {
    unchanged(checkout, commit);
    if (memory.has(commit)) return memory.get(commit);
    const directory = cellsCacheDirectory('inventory');
    const file = inventoryCacheFile(key, commit);
    let inventory = file && eligible() ? read(file, commit) : null;
    if (inventory) { unchanged(checkout, commit); onMode('base-cache'); }
    // Main moves every few minutes, so the exact commit is rarely cached; the nearest cached ancestor plus the
    // files changed since it gives the same inventory at the cost of the diff (#2601).
    const derived = !inventory && file && eligible() ? fromAncestor(checkout, commit) : null;
    if (!inventory) {
      if (!derived) onMode('base-full');
      inventory = derived ?? cellInventory(checkout, parsers);
      unchanged(checkout, commit);
      if (file && eligible()) try {
        const payload = serialize(inventory);
        const data = { version: 2, commit, checker, digest: createHash('sha256').update(payload).digest('hex'), payload };
        if (!eligible()) throw new Error('preload changed');
        publishCacheEntry(directory, file, gzipSync(serialize(data)));
      } catch { /* A cache write failure only costs a later census. */ }
    }
    memory.set(commit, inventory);
    return inventory;
  }
  /** Read the cached inventory of one commit under this checker; a missing, damaged or foreign entry is never evidence. */
  function read(file, commit) {
    try {
      const data = deserialize(gunzipSync(readFileSync(file), { maxOutputLength: 256 * 1024 * 1024 }));
      if (data.version !== 2 || data.commit !== commit || data.checker !== checker || !Buffer.isBuffer(data.payload)
        || data.digest !== createHash('sha256').update(data.payload).digest('hex')) throw new Error('invalid inventory cache');
      const inventory = deserialize(data.payload);
      if (!(inventory.files instanceof Map) || !(inventory.edges instanceof Map) || !Array.isArray(inventory.unknown)
        || [...inventory.files].some(([path, bytes]) => typeof path !== 'string' || !Buffer.isBuffer(bytes))
        || [...inventory.edges].some(([path, rows]) => typeof path !== 'string' || !Array.isArray(rows))
        || inventory.unknown.some(row => !row || typeof row.file !== 'string')) throw new Error('invalid inventory cache');
      if (!eligible()) throw new Error('preload changed');
      touch(file);
      return inventory;
    } catch { return null; } // Missing or damaged evidence requires another source.
  }
  /** The nearest cached first-parent ancestor's inventory, updated by the paths changed since it; null when none is cached. */
  function fromAncestor(checkout, commit) {
    let ancestors;
    try { ancestors = git(checkout, ['rev-list', '--first-parent', `--max-count=${ANCESTORS}`, commit]).split('\n').filter(Boolean).slice(1); }
    catch { return null; }
    for (const ancestor of ancestors) {
      const file = inventoryCacheFile(key, ancestor);
      const cached = existsSync(file) ? read(file, ancestor) : null;
      if (!cached) continue;
      let changed;
      try { changed = git(checkout, ['diff', '--no-renames', '--name-only', '-z', ancestor, commit]).split('\0').filter(Boolean); }
      catch { return null; }
      onMode(needsFullCensus(changed) ? 'base-full' : 'base-ancestor');
      return updateCellInventory(checkout, parsers, cached, changed);
    }
    return null;
  }
  /** Update only the changed, added and deleted paths; package.json, the kernel front door and discovery.js keep the full census. */
  function candidate(checkout, prior, changed) {
    const fallback = needsFullCensus(changed);
    onMode(fallback ? 'candidate-full-fallback' : 'candidate-incremental');
    return fallback ? cellInventory(checkout, parsers) : updateCellInventory(checkout, parsers, prior, changed);
  }
  return { base, candidate };
}

/**
 * The submit checker's identity by the bytes of its code at paths inside this tool, or null without a key. Why not the
 * key's own checkDigest: it names files by absolute path, and each runner job runs main's tools from a new temporary
 * folder, so no job ever found another's observations (#2601).
 */
function stableChecker(key) {
  if (!key || !Array.isArray(key.code)) return null;
  try {
    return receiptDigest({ node: process.version, preloads: key.config?.preloads ?? null,
      files: checkCommandDefinition(fileURLToPath(new URL('..', import.meta.url)), [], key.code).map(file => [file.path, file.mode, file.digest]) });
  } catch { return null; }
}

/**
 * Persist only complete compiler and lexical observations from checked immutable snapshots. Every entry names its own
 * exact inputs (source bytes or a commit), so one file per checker serves every main commit and job (#2601).
 */
export function observationCache(root, key, eligible = () => false) {
  const directory = cellsCacheDirectory('observations');
  const checker = stableChecker(key);
  const file = checker ? join(directory, `${checker}.json.gz`) : null;
  let values = new Map();
  if (file && eligible()) try {
    const data = JSON.parse(gunzipSync(readFileSync(file), { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8'));
    if (data.version !== 2 || data.checker !== checker || data.digest !== receiptDigest(data.payload)) throw new Error('invalid observations');
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
      // Oldest entries leave first, so one machine's file stays within the bounds a later load accepts.
      let bytes = [...values.values()].reduce((sum, row) => sum + row.bytes, 0);
      for (const [id, row] of values) {
        if (values.size <= 24576 && bytes <= 96 * 1024 * 1024) break;
        values.delete(id); bytes -= row.bytes;
      }
      const payload = serialize(values).toString('base64');
      const data = { version: 2, checker, digest: receiptDigest(payload), payload };
      if (!eligible()) return;
      publishCacheEntry(directory, file, gzipSync(Buffer.from(JSON.stringify(data))));
    } catch { /* Optional observations never replace a real analysis. */ }
  }
  return { values, commit };
}
