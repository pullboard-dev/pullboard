/** Reuse fixture analysis and immutable tree metadata across the cells inspected by one sweep [C7]. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { deserialize } from 'node:v8';
import { gzipSync } from 'node:zlib';
import { gunzipSync } from 'node:zlib';
import { gitSpawnSync } from '../../../../git/index.js';
import { cellSourceSnapshot } from '../cell/snapshot.js';

/** Own one analysis session; the entry point supplies its trusted analyzer, cache policy and publication ports. */
export function createFixtureMemo({ fixtureSourceEdits, cellsCacheDirectory, publishCacheEntry, analyzerDigest, eligible, onTreeRead } = {}) {
  const trees = new Map();
  /**
   * Base blob text by object id, so each touched cell's base reads share one Git process per object (#3896); an
   * object id names its bytes, so a remembered read can never be stale. The oldest leave first past the bound.
   */
  const baseBlobs = new Map();
  const BASE_BLOBS = 4096;
  /** How many analyses one machine keeps; the oldest unused leave first. */
  const KEEP = 200_000;

  let memory = null;
  let file = null;
  let dirty = false;

  /** Load this analyzer's remembered results once per process; a missing or damaged file starts empty. */
  function load() {
    if (memory) return memory;
    memory = new Map();
    try {
      file = join(cellsCacheDirectory('fixtures'), `${analyzerDigest()}.v8.gz`);
      const data = deserialize(gunzipSync(readFileSync(file), { maxOutputLength: 512 * 1024 * 1024 }));
      if (data?.version === 1 && data.entries instanceof Map) memory = data.entries;
    } catch { /* A first run or damaged file only costs analysis. */ }
    return memory;
  }

  /** Digest a value's exact JSON form. */
  function digest(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  /**
   * Run analyze(source, options) once per exact input: the file's bytes, its moves, the data-read manifest and the
   * blob of every file the analysis read through options.readSource. A remembered result is reused only while each of
   * those blobs is unchanged; a foreign preload, an unreadable source or a thrown analysis is never remembered. Why:
   * the cells check analyses every test file once per touched cell, and on a runner that was most of the gate (#2601).
   */
  function rememberedFixtureEdits(analyze, source, options) {
    if (!eligible() || typeof options?.readSource !== 'function') return analyze(source, options);
    const entries = load();
    const key = digest([options.file, digest(source), options.moves, options.dataReads ?? [], options.mentionsOnly === true]);
    const known = entries.get(key);
    // objectOf, when given, names a file's blob without reading its bytes; it must agree with readSource's object.
    const objectOf = typeof options.objectOf === 'function' ? options.objectOf : path => options.readSource(path)?.object ?? null;
    if (known && known.reads.every(([path, object]) => objectOf(path) === object)) {
      entries.delete(key); entries.set(key, known); // Most recently used last, so pruning keeps it.
      return deserialize(known.result);
    }
    const reads = new Map();
    const { objectOf: _unused, ...analyzed } = options;
    const result = analyze(source, { ...analyzed, readSource: path => {
      const found = options.readSource(path);
      reads.set(path, found?.object ?? null);
      return found;
    } });
    try {
      entries.delete(key);
      entries.set(key, { reads: [...reads], result: serialize(result) });
      dirty = true;
    } catch { /* An unserializable result is simply not remembered. */ }
    return result;
  }

  /** Publish this process's remembered analyses for the next job; a failed write only costs a later analysis. */
  function saveFixtureEdits() {
    if (!dirty || !memory || !file) return;
    dirty = false;
    try {
      while (memory.size > KEEP) memory.delete(memory.keys().next().value);
      publishCacheEntry(cellsCacheDirectory('fixtures'), file, gzipSync(serialize({ version: 1, entries: memory })));
    } catch { /* Optional. */ }
  }

  /** Every regular blob a commit's tree names, by path: one Git process for a whole analysis. */
  function treeBlobs(root, commit) {
    const key = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit) ? root + '\0' + commit : null;
    if (key && trees.has(key)) return new Map(trees.get(key));
    onTreeRead?.();
    const snapshot = cellSourceSnapshot(root);
    if (snapshot && commit === snapshot.commit) {
      const blobs = new Map();
      for (const [path, entry] of snapshot.entries) {
        if (['100644', '100755'].includes(entry.mode) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(entry.object ?? '')) blobs.set(path, entry.object);
      }
      if (key) trees.set(key, blobs);
      return new Map(blobs);
    }
    const listed = gitSpawnSync(['ls-tree', '-r', '-z', commit], { cwd: snapshot?.repoRoot ?? root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const blobs = new Map();
    if (listed.status !== 0) return blobs;
    for (const row of listed.stdout.split('\0')) {
      const match = /^100(?:644|755) blob ([a-f0-9]+)\t(.+)$/su.exec(row);
      if (match) blobs.set(match[2], match[1]);
    }
    if (key) trees.set(key, blobs);
    return new Map(blobs);
  }

  /** Split one analyzer refusal into its exact source line text and reason, or null for any other problem. */
  function unsupportedSite(problem, file, source) {
    const match = /^(.+):(\d+): unsupported fixture source: (.+)$/u.exec(problem);
    if (!match || match[1] !== file) return null;
    const text = source.split('\n')[Number(match[2]) - 1];
    return text === undefined ? null : { text: text.trim(), reason: match[3] };
  }

  /**
   * Count the same file's unproven reads at the move's main base, by exact line text and reason, from committed
   * bytes only. Why: a read the analyzer could not prove before the move is not a gap the move made, while a read
   * whose line names a moved basename, or any new or extra occurrence, still counts against the move.
   */
  function baseUnsupported(root, base, file, { moves, dataReads }) {
    const counts = new Map();
    if (!base) return counts;
    const blobs = treeBlobs(root, base);
    const repository = cellSourceSnapshot(root)?.repoRoot ?? root;
    /** The regular blob a path names at the base commit, or null. */
    const objectOf = path => (/^[\w./-]+$/u.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..') && blobs.get(path)) || null;
    /** Read one regular blob at the base commit, never the working tree; each object is read from Git once. */
    function readBase(path) {
      const object = objectOf(path);
      if (!object) return null;
      // Exact bytes come from Git directly; the analyzer re-hashes them against the object.
      if (!baseBlobs.has(object)) {
        const shown = gitSpawnSync(['cat-file', 'blob', object], { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 });
        if (baseBlobs.size >= BASE_BLOBS) baseBlobs.delete(baseBlobs.keys().next().value);
        baseBlobs.set(object, shown?.status === 0 ? shown.stdout : null);
      }
      const source = baseBlobs.get(object);
      return source === null ? null : { source, object };
    }
    const original = readBase(file);
    if (!original) return counts;
    const uses = rememberedFixtureEdits(fixtureSourceEdits, original.source, { file, moves, readSource: readBase, objectOf, dataReads, mentionsOnly: true });
    for (const problem of uses.problems) {
      const site = unsupportedSite(problem, file, original.source);
      if (site) counts.set(`${site.text}\0${site.reason}`, (counts.get(`${site.text}\0${site.reason}`) ?? 0) + 1);
    }
    return counts;
  }
  return { rememberedFixtureEdits, saveFixtureEdits, treeBlobs, baseUnsupported, unsupportedSite };
}
