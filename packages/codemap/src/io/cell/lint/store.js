/** Store exact falling allowances in bounded, hash-bound metadata shards; incomplete generations refuse [C7,CD64]. */
import { createHash } from 'node:crypto';
import {
  cellExistsSync,
  cellReadFileSync,
  cellSourceSnapshot,
} from '../snapshot.js';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../../fs/index.js';
import { cellLintCells } from './shards.js';
import { translatedBase } from './shards.js';
import { translatedKey } from './shards.js';
import { readCellLintCellBaseline } from './shards.js';
import { writeCellLintCellBaseline } from './shards.js';
import { CELL_METRICS } from '../lints.js';
import { validateCellLintBaseline } from './ratchet.js';
import { Refused } from '../../../../../kernel/index.js';

import { readPathMap } from '../../../logic/path/map.js';
import { pathMapFromFiles } from '../../../logic/path/map.js';
import { CELL_BASELINE_DESCRIPTOR } from '../../../logic/path/map.js';
import { CELL_BASELINE_DIRECTORY } from '../../../logic/path/map.js';
import { storeName } from '../../store-names.js';
export { CELL_BASELINE_DESCRIPTOR };
export { CELL_BASELINE_DIRECTORY };
const fs = fileSystemAdapter();
const DIRECTORY = CELL_BASELINE_DIRECTORY, DESCRIPTOR = CELL_BASELINE_DESCRIPTOR;
/** Hash the exact persisted UTF-8 bytes, including the final newline. */
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
/** Retain ordinary readable JSON and enforce the same under-500-line limit as source. */
function encode(value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (bytes.split('\n').length - 1 >= 500) throw new Refused('CELL_BASELINE', 'split cell lint metadata into smaller bounded shards');
  return bytes;
}

/** Produce deterministic immutable shard bytes without writing or changing a baseline. */
export function cellLintFiles(baseline) {
  validateCellLintBaseline(baseline);
  const files = new Map(), descriptor = { version: 2, metrics: {} };
  for (const metric of CELL_METRICS) {
    const row = baseline.metrics[metric], entries = Object.entries(row.allowances).sort(([a], [b]) => a.localeCompare(b));
    descriptor.metrics[metric] = { count: row.count, shards: [] };
    for (let start = 0; start < entries.length; start += 400) {
      const bytes = encode({ version: 1, metric, allowances: Object.fromEntries(entries.slice(start, start + 400)) });
      const hash = digest(bytes), file = `${DIRECTORY}/${metric}-${storeName(String(start / 400 + 1).padStart(3, '0'))}`;
      files.set(file, bytes);
      descriptor.metrics[metric].shards.push({ file, sha256: hash });
    }
  }
  files.set(DESCRIPTOR, encode(descriptor));
  return files;
}

/** The committed path map, read the way the cell lint reader reads it. */
function committedPathMap(root) {
  const snapshot = cellSourceSnapshot(root);
  return snapshot ? pathMapFromFiles(snapshot.files, snapshot.entries) : readPathMap(root);
}

/** Map a baseline keyed by cell path back to the committed legacy keys; keys already legacy or unknown pass through, and an ambiguous cell key is refused. */
function legacyKeyed(root, baseline, base) {
  const map = committedPathMap(root);
  return { version: 1, metrics: Object.fromEntries(CELL_METRICS.map(metric => {
    const inverse = new Map();
    for (const key of Object.keys(base.metrics[metric].allowances)) {
      const cell = translatedKey(metric, key, map);
      inverse.set(cell, inverse.has(cell) ? null : key);
    }
    const allowances = Object.create(null);
    for (const [key, count] of Object.entries(baseline.metrics[metric].allowances)) {
      if (inverse.get(key) === null) throw new Refused('CELL_BASELINE', `cell key ${metric}:${key} is ambiguous between two committed legacy keys`);
      allowances[inverse.get(key) ?? key] = count;
    }
    return [metric, { count: Object.values(allowances).reduce((sum, count) => sum + count, 0), allowances }];
  })) };
}

/** Read only complete, hash-bound generations; no missing shard ever becomes a lower allowance. */
function readLegacyCellLintBaseline(root) {
  try {
    const descriptor = JSON.parse(cellReadFileSync(join(root, DESCRIPTOR), 'utf8'));
    if (descriptor?.version !== 2 || !descriptor.metrics || Object.keys(descriptor.metrics).sort().join() !== [...CELL_METRICS].sort().join()) throw new Error('invalid descriptor');
    const baseline = { version: 1, metrics: {} }, seen = new Set();
    for (const metric of CELL_METRICS) {
      const row = descriptor.metrics[metric], allowances = Object.create(null);
      if (!Array.isArray(row?.shards)) throw new Error('missing shard list');
      for (const [index, reference] of row.shards.entries()) {
        if (!/^[a-f0-9]{64}$/u.test(reference.sha256) || reference.file !== `${DIRECTORY}/${metric}-${storeName(String(index + 1).padStart(3, '0'))}` || seen.has(reference.file)) throw new Error('invalid shard reference');
        seen.add(reference.file);
        const bytes = cellReadFileSync(join(root, reference.file)), shard = JSON.parse(bytes);
        if (digest(bytes) !== reference.sha256 || shard?.version !== 1 || shard.metric !== metric || !shard.allowances || Array.isArray(shard.allowances)) throw new Error('unbound shard');
        for (const [key, count] of Object.entries(shard.allowances)) {
          if (Object.hasOwn(allowances, key)) throw new Error('duplicate allowance');
          allowances[key] = count;
        }
      }
      baseline.metrics[metric] = { count: row.count, allowances };
    }
    validateCellLintBaseline(baseline);
    return baseline;
  } catch (error) {
    throw new Refused('CELL_BASELINE', `restore the complete hash-bound cell lint baseline: ${error.message}`);
  }
}

/** Combine the immutable accepted generation with the complete per-cell falling deltas, keyed by cell path once a path-map cell exists. */
export function readCellLintBaseline(root) {
  try {
    const baseline = readCellLintCellBaseline(root, readLegacyCellLintBaseline(root));
    if (!cellLintCells(root).length) return baseline;
    return translatedBase(baseline, committedPathMap(root));
  }
  catch (error) { throw new Refused('CELL_BASELINE', `restore the complete per-cell cell lint baseline: ${error.message}`); }
}

/** Seed one empty shard for each existing path-map cell without rewriting accepted legacy bytes. */
export function initializeCellLintCellShards(root) {
  if (!cellLintCells(root).length) throw new Refused('CELL_BASELINE', 'no per-cell path-map shards exist');
  const base = readLegacyCellLintBaseline(root);
  writeCellLintCellBaseline(root, base, base, () => true);
}

/** Capture only the validated generation's actual bytes for precise planning and rollback. */
export function storedCellLintFiles(root) {
  readCellLintBaseline(root);
  const descriptor = cellReadFileSync(join(root, DESCRIPTOR)), parsed = JSON.parse(descriptor);
  const legacy = [[DESCRIPTOR, descriptor], ...Object.values(parsed.metrics).flatMap(row => row.shards.map(({ file }) => [file, cellReadFileSync(join(root, file))]))];
  const cells = cellLintCells(root).map(cell => `${DIRECTORY}/cells/${storeName(cell)}`).filter(file => cellExistsSync(join(root, file)));
  return new Map([...legacy, ...cells.map(file => [file, cellReadFileSync(join(root, file))])]);
}

/** Publish bounded shards and an atomic descriptor; failed final verification restores the exact prior generation. */
export function writeCellLintBaseline(root, baseline, { initialize = false, verify = () => true, previous = null } = {}) {
  if (cellLintCells(root).length && cellExistsSync(join(root, DESCRIPTOR))) {
    if (initialize) throw new Refused('CELL_BASELINE', 'baseline already exists; use explicit falling update');
    const base = readLegacyCellLintBaseline(root);
    if (previous && JSON.stringify(readCellLintBaseline(root)) !== JSON.stringify(translatedBase(previous, committedPathMap(root)))) throw new Refused('CELL_BASELINE', 'baseline changed since planning; read the current per-cell generation');
    writeCellLintCellBaseline(root, base, legacyKeyed(root, baseline, base), verify);
    return;
  }
  const files = cellLintFiles(baseline), descriptor = join(root, DESCRIPTOR);
  fs.mkdir(join(root, DIRECTORY), { recursive: true });
  const lock = join(root, DIRECTORY, '.write-lock');
  fs.mkdir(lock);
  const pending = descriptor + `.pending-${process.pid}`;
  let before, pendingCreated = false;
  const written = new Set();
  try {
    if (initialize && cellExistsSync(descriptor)) throw new Refused('CELL_BASELINE', 'baseline already exists; use explicit falling update');
    before = initialize ? new Map() : storedCellLintFiles(root);
    if (previous && JSON.stringify(readCellLintBaseline(root)) !== JSON.stringify(previous)) throw new Refused('CELL_BASELINE', 'baseline changed since planning; read and plan the current generation');
    for (const file of files.keys()) if (!before.has(file) && cellExistsSync(join(root, file))) throw new Refused('CELL_BASELINE', `refuse overwriting unowned metadata ${file}`);
    for (const [file, bytes] of files) if (file !== DESCRIPTOR) { written.add(file); fs.writeFile(join(root, file), bytes); }
    fs.writeFile(pending, files.get(DESCRIPTOR), { flag: 'wx' });
    pendingCreated = true;
    fs.rename(pending, descriptor);
    written.add(DESCRIPTOR);
    for (const file of before.keys()) if (!files.has(file)) fs.unlink(join(root, file));
    readCellLintBaseline(root);
    if (!verify()) throw new Refused('CELL_BASELINE', 'final literal repository inventory differs from the planned baseline; inspect concurrent source changes');
  } catch (error) {
    if (before) {
      for (const [file, bytes] of before) fs.writeFile(join(root, file), bytes);
      for (const file of written) if (!before.has(file) && cellExistsSync(join(root, file))) fs.unlink(join(root, file));
    }
    throw error;
  } finally {
    if (pendingCreated && cellExistsSync(pending)) fs.unlink(pending);
    fs.rmdir(lock);
  }
}
