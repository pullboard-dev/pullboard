/** Per-file static check results kept under the machine home, so a landing rescans only the files it changed [5564]. */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cellOf } from '../edges.js';
import { fileEdges } from '../edges.js';
import { machineHome } from '../../../../resources/index.js';

/** Git's blob object id of some text, computed in process so no git call is needed per file. */
export function blobOid(text) {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * The oid of the tooling the file-local checks run on: every source file of the packages those checks import. A change to
 * the tooling invalidates every cached row, so a rule edit can never be answered from rows an older rule made.
 *
 * @param {{file: string, source: string}[]} sources - The style sources of the tree, read once.
 * @returns {string}
 */
export function toolingKey(sources) {
  const hash = createHash('sha1');
  for (const { file, source } of sources) {
    if (/^packages\/(?:gate|codemap|kernel|git|state|doctrine|config)\/src\//u.test(file)) hash.update(`${file}\0${blobOid(source)}\n`);
  }
  return hash.digest('hex');
}

/**
 * A cache of one check's per-file results. An entry is reused only when the file's blob oid, the check's rule version and
 * the tooling key all match; anything else recomputes, so the rows equal a full run's rows exactly.
 *
 * @param {{name: string, version: number | string, tooling: string, home?: string | null}} options - `home: null` keeps it in memory only.
 * @returns {{get: (path: string, oid: string, compute: () => unknown) => unknown, save: () => void, hits: number, misses: number}}
 */
export function fileCache({ name, version, tooling, home = undefined }) {
  const dir = home === null ? null : join(home ?? join(machineHome(), 'static-cache'));
  const path = dir ? join(dir, `${name}.json`) : null;
  let entries = {};
  if (path) {
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8'));
      if (stored.version === version && stored.tooling === tooling) entries = stored.entries;
    } catch { /* no cache yet, or an unreadable one: start empty */ }
  }
  const seen = new Set();
  let dirty = false;
  const cache = {
    hits: 0,
    misses: 0,
    get(file, oid, compute) {
      seen.add(file);
      const entry = entries[file];
      if (entry && entry.oid === oid) { cache.hits++; return entry.value; }
      cache.misses++;
      const value = compute();
      entries[file] = { oid, value };
      dirty = true;
      return value;
    },
    save() {
      if (!path || !dirty) return;
      // Drop files that left the tree only when the cache has grown far past it, so two trees can share one cache.
      if (Object.keys(entries).length > seen.size * 2) entries = Object.fromEntries(Object.entries(entries).filter(([file]) => seen.has(file)));
      try {
        mkdirSync(dir, { recursive: true });
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify({ version, tooling, entries }));
        renameSync(temporary, path);
      } catch { /* a cache that cannot be written only costs the next run its speed */ }
    },
  };
  return cache;
}

/**
 * A key for a check that reads across files but only inside some cells: the blobs of every file in the named cells, in every
 * cell they import (transitively, by the import edges of the cell graph), and in the root, plus the tree's full path list
 * and any extra files. A landing that touches none of those cells leaves the key, and so the check's answer, unchanged.
 *
 * @param {{file: string, source: string}[]} sources - The style sources of the tree.
 * @param {string[]} cells - Entry cells as cellOf names them, such as `runners` or `apps/cli`.
 * @param {{edgeCache: ReturnType<typeof fileCache>, extra?: string[], read?: (file: string) => string}} options - Per-file import edges are kept in `edgeCache`.
 * @returns {string}
 */
export function cellScopedKey(sources, cells, { edgeCache, extra = [], read = () => '' }) {
  const owner = new Map(), imports = new Map();
  for (const { file, source } of sources) {
    const own = cellOf(file).cell;
    owner.set(file, own);
    const edges = edgeCache.get(file, blobOid(source), () => fileEdges(file, source).map(edge => edge.to));
    if (!imports.has(own)) imports.set(own, new Set());
    for (const to of edges) imports.get(own).add(to);
  }
  const reached = new Set(cells), queue = [...cells];
  for (let at = 0; at < queue.length; at++) for (const to of imports.get(queue[at]) ?? []) if (!reached.has(to)) { reached.add(to); queue.push(to); }
  const hash = createHash('sha1');
  for (const { file, source } of sources) {
    hash.update(`${file}\0${reached.has(owner.get(file)) || owner.get(file) === '(root)' ? blobOid(source) : ''}\n`);
  }
  for (const file of extra) hash.update(`${file}\0${blobOid(read(file))}\n`);
  return hash.digest('hex');
}
