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
import { storeName } from '../store-names.js';

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
 * the tooling key all match (and the entry's own `valid` test passes, for rows that also depend on files outside the blob);
 * anything else recomputes, so the rows equal a full run's rows exactly.
 *
 * @param {{name: string, version: number | string, tooling: string, home?: string | null}} options - `home: null` keeps it in memory only.
 * @returns {{get: (path: string, oid: string, compute: () => unknown, valid?: (value: any) => boolean) => any, save: () => void, hits: number, misses: number}}
 */
export function fileCache({ name, version, tooling, home = undefined }) {
  const dir = home === null ? null : join(home ?? join(machineHome(), 'static-cache'));
  const path = dir ? join(dir, storeName(name)) : null;
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
    /** Whether `get` would answer this file from the cache, without counting a hit or a miss. */
    has(file, oid) { return entries[file]?.oid === oid; },
    get(file, oid, compute, valid = () => true) {
      seen.add(file);
      const entry = entries[file];
      if (entry && entry.oid === oid && valid(entry.value)) { cache.hits++; return entry.value; }
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

const GRAPHS = new WeakMap();

/**
 * The cell graph of one source list, built once per list: each file's blob oid, its owner cell, the cells each cell imports
 * (from `edgeCache`, per file by blob) and a digest of each cell's files. Every cell-scoped key and partition reads it [5567].
 *
 * @param {{file: string, source: string}[]} sources - The style sources of the tree.
 * @param {ReturnType<typeof fileCache>} edgeCache - Per-file import edges, kept by blob.
 */
export function cellGraph(sources, edgeCache) {
  const known = GRAPHS.get(sources);
  if (known?.edgeCache === edgeCache) return known.graph;
  const owner = new Map(), imports = new Map(), byCell = new Map(), digest = new Map();
  const paths = createHash('sha1');
  for (const row of sources) {
    const oid = blobOid(row.source), own = cellOf(row.file).cell;
    owner.set(row.file, own);
    if (!byCell.has(own)) { byCell.set(own, []); imports.set(own, new Set()); digest.set(own, createHash('sha1')); }
    byCell.get(own).push(row);
    digest.get(own).update(`${row.file}\0${oid}\n`);
    paths.update(`${row.file}\n`);
    for (const to of edgeCache.get(row.file, oid, () => fileEdges(row.file, row.source).map(edge => edge.to))) imports.get(own).add(to);
  }
  const cellDigest = new Map([...digest].map(([cell, hash]) => [cell, hash.digest('hex')]));
  const pathsDigest = paths.digest('hex');
  const graph = {
    cells: [...byCell.keys()].sort(),
    ownerOf: file => owner.get(file) ?? cellOf(file).cell,
    /** The cells named plus every cell they import, transitively, and the root. */
    reach(cells) {
      const reached = new Set([...cells, '(root)']), queue = [...reached];
      for (let at = 0; at < queue.length; at++) for (const to of imports.get(queue[at]) ?? []) if (!reached.has(to)) { reached.add(to); queue.push(to); }
      return reached;
    },
    /** The sources of some cells, in tree order. */
    sourcesOf: reached => sources.filter(row => reached.has(owner.get(row.file))),
    /** The key of the cells' reach: their blobs, plus the full path list unless `paths` is false, plus extra files. */
    key(cells, { paths: withPaths = true, extra = [], read = () => '' } = {}) {
      const hash = createHash('sha1');
      if (withPaths) hash.update(pathsDigest);
      for (const cell of [...graph.reach(cells)].sort()) hash.update(`${cell}\0${cellDigest.get(cell) ?? ''}\n`);
      for (const file of extra) hash.update(`${file}\0${blobOid(read(file))}\n`);
      return hash.digest('hex');
    },
  };
  GRAPHS.set(sources, { edgeCache, graph });
  return graph;
}

/**
 * A key for a check that reads across files but only inside some cells: the blobs of every file in the named cells, in every
 * cell they import (transitively, by the import edges of the cell graph), and in the root, plus the tree's full path list
 * and any extra files. A landing that touches none of those cells leaves the key, and so the check's answer, unchanged.
 *
 * @param {{file: string, source: string}[]} sources - The style sources of the tree.
 * @param {string[]} cells - Entry cells as cellOf names them, such as `runners` or `apps/cli`.
 * @param {{edgeCache: ReturnType<typeof fileCache>, extra?: string[], read?: (file: string) => string, paths?: boolean}} options - Per-file import edges are kept in `edgeCache`.
 * @returns {string}
 */
export function cellScopedKey(sources, cells, { edgeCache, extra = [], read = () => '', paths = true }) {
  return cellGraph(sources, edgeCache).key(cells, { paths, extra, read });
}

/**
 * Run a check that judges each file against the files it can reach, one cell at a time: a cell's rows are cached under the
 * key of that cell plus the cells it imports, so a landing reruns only the cells whose reach changed. `compute` gets the
 * sources of the reach of every stale cell together and must return rows for all of them; only rows whose file lives in a
 * cell are kept under it, so every row is kept once and the rows equal a full run's.
 *
 * @param {{sources: {file: string, source: string}[], edgeCache: ReturnType<typeof fileCache>, cache: ReturnType<typeof fileCache>, compute: (sources: {file: string, source: string}[]) => object[], fileOf?: (row: object) => string}} options
 * @returns {object[]} Rows in tree order of their files, a file's rows in the order `compute` made them.
 */
export function cellRows({ sources, edgeCache, cache, compute, fileOf = row => row.file }) {
  const graph = cellGraph(sources, edgeCache), keys = new Map(graph.cells.map(cell => [cell, graph.key([cell], { paths: false })]));
  // One compute call covers every stale cell: the union of their reaches holds all each of them reads, and a cold cache makes it the full run.
  const stale = graph.cells.filter(cell => !cache.has(cell, keys.get(cell)));
  let fresh = null;
  if (stale.length) {
    const reached = new Set(stale.flatMap(cell => [...graph.reach([cell])]));
    fresh = compute(graph.sourcesOf(reached));
  }
  const rows = [];
  for (const cell of graph.cells) rows.push(...cache.get(cell, keys.get(cell), () => fresh.filter(row => graph.ownerOf(fileOf(row)) === cell)));
  const order = new Map(sources.map((row, at) => [row.file, at]));
  return rows.map((row, at) => ({ row, at })).sort((a, b) => (order.get(fileOf(a.row)) ?? 0) - (order.get(fileOf(b.row)) ?? 0) || a.at - b.at).map(({ row }) => row);
}
