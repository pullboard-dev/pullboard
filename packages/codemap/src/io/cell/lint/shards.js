/** Per-cell falling allowances over an immutable accepted baseline generation [C7,CD64]. */
import { createHash } from 'node:crypto';
import {
  cellExistsSync,
  cellReadFileSync,
  cellReaddirSync,
  cellSourceSnapshot,
} from '../snapshot.js';
import { mkdirSync } from 'node:fs';
import { rmdirSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CELL_METRICS } from '../lints.js';
import { cellLintGrowth } from './ratchet.js';
import { validateCellLintBaseline } from './ratchet.js';
import { tryGit } from '../../../../../git/index.js';
import {
  readPathMap,
  pathMapFromFiles,
} from '../../../logic/path/map.js';
import { Refused } from '../../../../../kernel/index.js';
import { storeName } from '../../store-names.js';

const MAP_DIRECTORY = 'packages/codemap/data/plan/path-map';
const SHARD_DIRECTORY = 'packages/codemap/data/baselines/lints/cells';
const DESCRIPTOR = 'packages/codemap/data/baselines/lints/index.json';
/** Hash the exact accepted legacy descriptor or a canonical cell payload. */
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
/** Bound each metadata file below the source line limit. */
function encode(value) {
  const readable = JSON.stringify(value, null, 2) + '\n';
  return readable.split('\n').length - 1 < 500 ? readable : JSON.stringify(value) + '\n';
}
/** List only named path-map shards; each committed cell map requires its own baseline shard. */
export function cellLintCells(root) {
  const directory = join(root, MAP_DIRECTORY);
  if (!cellExistsSync(directory)) return [];
  const names = cellReaddirSync(directory).sort();
  if (names.some(name => !/^[a-z][a-z0-9-]*\.json$/u.test(name))) throw new Refused('CELL_BASELINE', 'unexpected path-map shard name');
  return names.map(name => name.slice(0, -5));
}
/** Read each cell's explicit old-to-new path identities without consulting live board state. */
function cellMaps(root, cells) {
  return new Map(cells.map(cell => {
    const value = JSON.parse(cellReadFileSync(join(root, MAP_DIRECTORY, `${storeName(cell)}`), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refused('CELL_BASELINE', `invalid ${cell} path-map shard`);
    return [cell, value];
  }));
}
/** Read accepted shard names once, even when many new cells lack a shard. */
function acceptedShards(root) {
  const snapshot = cellSourceSnapshot(root);
  if (snapshot) return new Set([...snapshot.entries.keys()].filter(file => file.startsWith(`${SHARD_DIRECTORY}/`)));
  const result = tryGit(root, ['ls-tree', '-r', '--name-only', 'HEAD', '--', SHARD_DIRECTORY]);
  return new Set(result.status === 0 ? result.stdout.split('\n').filter(Boolean) : []);
}
/** Assign a changed allowance to the moved path's cell, retaining disjoint shard ownership. */
function allowanceCell(metric, key, maps) {
  const paths = (key.includes('->') ? key.split('->') : [metric === 'unknown' ? key.slice(0, key.indexOf(':')) : key.split('#')[0]])
    .map(path => path.replace(/^temporary:/u, ''));
  for (const [cell, map] of maps) if (paths.some(path => Object.hasOwn(map, path))) return cell;
  for (const path of paths) {
    const match = /^(?:packages|apps)\/([a-z][a-z0-9-]*)(?:\/|$)/u.exec(path);
    if (match) {
      const cell = path.startsWith('apps/') ? `app-${match[1]}` : match[1];
      if (maps.has(cell)) return cell;
    }
  }
  return null;
}
/** Produce canonical, self-hash-bound delta bytes without changing the legacy snapshot. */
export function cellLintCellFiles(root, base, target) {
  validateCellLintBaseline(base);
  validateCellLintBaseline(target);
  const cells = cellLintCells(root), maps = cellMaps(root, cells);
  const edits = new Map(cells.map(cell => [cell, {}]));
  for (const metric of CELL_METRICS) {
    const old = base.metrics[metric].allowances, next = target.metrics[metric].allowances;
    for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (old[key] === next[key]) continue;
      const cell = allowanceCell(metric, key, maps);
      if (!cell) throw new Refused('CELL_BASELINE', `changed ${metric}:${key} has no per-cell path-map owner`);
      const row = edits.get(cell)[metric] ??= { remove: [], allowances: {} };
      if (Object.hasOwn(old, key)) row.remove.push(key);
      if (Object.hasOwn(next, key)) row.allowances[key] = next[key];
    }
  }
  const baseSha256 = digest(cellReadFileSync(join(root, DESCRIPTOR)));
  return new Map(cells.map(cell => {
    const metrics = edits.get(cell);
    for (const row of Object.values(metrics)) row.remove.sort();
    const payload = { version: 1, cell, baseSha256, metrics };
    return [`${SHARD_DIRECTORY}/${storeName(cell)}`, encode({ ...payload, sha256: digest(encode(payload)) })];
  }));
}
/** Combine all expected cell deltas, refusing omissions, changed bytes or overlapping edits. */
export function readCellLintCellBaseline(root, base) {
  const cells = cellLintCells(root);
  if (!cells.length) return base;
  const directory = join(root, SHARD_DIRECTORY), actual = cellExistsSync(directory) ? cellReaddirSync(directory).filter(name => name !== '.write-lock').sort() : [];
  const missing = cells.filter(cell => !actual.includes(`${storeName(cell)}`));
  const accepted = missing.length ? acceptedShards(root) : new Set();
  if (actual.some(name => !cells.includes(name.slice(0, -5)) || !name.endsWith('.json'))
    || missing.some(cell => accepted.has(`${SHARD_DIRECTORY}/${storeName(cell)}`))) throw new Refused('CELL_BASELINE', 'restore the complete accepted per-cell baseline shard set');
  const baseSha256 = digest(cellReadFileSync(join(root, DESCRIPTOR)));
  const baseline = { version: 1, metrics: Object.fromEntries(CELL_METRICS.map(metric => [metric, {
    count: base.metrics[metric].count,
    allowances: { ...base.metrics[metric].allowances },
  }])) };
  const touched = new Set();
  for (const cell of cells) {
    if (!actual.includes(`${storeName(cell)}`)) continue;
    const document = JSON.parse(cellReadFileSync(join(root, SHARD_DIRECTORY, `${storeName(cell)}`), 'utf8'));
    if (!document || Object.keys(document).sort().join() !== 'baseSha256,cell,metrics,sha256,version') throw new Refused('CELL_BASELINE', `invalid ${cell} baseline document`);
    const { sha256, ...payload } = document;
    if (payload.version !== 1 || payload.cell !== cell || payload.baseSha256 !== baseSha256
      || sha256 !== digest(encode(payload)) || !payload.metrics || Array.isArray(payload.metrics)) throw new Refused('CELL_BASELINE', `invalid ${cell} baseline shard`);
    for (const [metric, row] of Object.entries(payload.metrics)) {
      if (!CELL_METRICS.includes(metric) || !Array.isArray(row?.remove) || !row.allowances || Array.isArray(row.allowances)
        || Object.keys(row).sort().join() !== 'allowances,remove' || new Set(row.remove).size !== row.remove.length) throw new Refused('CELL_BASELINE', `invalid ${cell} metric delta`);
      for (const key of new Set([...row.remove, ...Object.keys(row.allowances)])) {
        const identity = `${metric}:${key}`;
        if (touched.has(identity)) throw new Refused('CELL_BASELINE', `overlapping ${identity} baseline edits`);
        touched.add(identity);
      }
      for (const key of row.remove) {
        if (!Object.hasOwn(base.metrics[metric].allowances, key)) throw new Refused('CELL_BASELINE', `unbound ${metric}:${key} removal`);
        delete baseline.metrics[metric].allowances[key];
      }
      for (const [key, count] of Object.entries(row.allowances)) baseline.metrics[metric].allowances[key] = count;
    }
  }
  for (const metric of CELL_METRICS) baseline.metrics[metric].count = Object.values(baseline.metrics[metric].allowances).reduce((sum, count) => sum + count, 0);
  validateCellLintBaseline(baseline);
  if (touched.size) {
    const snapshot = cellSourceSnapshot(root);
    const pathMap = snapshot ? pathMapFromFiles(snapshot.files, snapshot.entries) : readPathMap(root);
    const report = { pathMap: Object.fromEntries(pathMap), metrics: Object.fromEntries(CELL_METRICS.map(metric => [metric, {
      findings: Object.entries(baseline.metrics[metric].allowances).map(([key, count]) => ({ key, count })),
    }])) };
    if (cellLintGrowth(report, base).length) throw new Refused('CELL_BASELINE', 'per-cell shard raises an accepted allowance');
  }
  return baseline;
}
/** Publish only per-cell shard files; a refused verification restores the exact prior bytes. */
export function writeCellLintCellBaseline(root, base, target, verify) {
  const files = cellLintCellFiles(root, base, target), directory = join(root, SHARD_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, '.write-lock');
  mkdirSync(lock);
  const before = new Map();
  try {
    readCellLintCellBaseline(root, base);
    for (const file of files.keys()) if (cellExistsSync(join(root, file))) before.set(file, cellReadFileSync(join(root, file)));
    for (const [file, bytes] of files) if (!before.has(file) || !before.get(file).equals(Buffer.from(bytes))) writeFileSync(join(root, file), bytes);
    const combined = readCellLintCellBaseline(root, base);
    if (JSON.stringify(combined) !== JSON.stringify(target) || !verify()) throw new Refused('CELL_BASELINE', 'per-cell baseline differs from the planned literal inventory');
  } catch (error) {
    for (const [file, bytes] of before) writeFileSync(join(root, file), bytes);
    for (const file of files.keys()) if (!before.has(file) && cellExistsSync(join(root, file))) unlinkSync(join(root, file));
    throw error;
  } finally { rmdirSync(lock); }
}
