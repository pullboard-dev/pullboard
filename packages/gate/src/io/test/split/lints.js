/** Move a split test's cell lint allowances to its measured siblings and rebind the hash-bound index [C7,CD64]. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CELL_METRICS } from '../../../../../codemap/index.js';
import { CELL_BASELINE_DESCRIPTOR } from '../../../../../codemap/index.js';

const CELL_SHARDS = 'packages/codemap/data/baselines/lints/cells';

/** Hash exact bytes, as the baseline store binds them. */
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
/** The legacy shards and descriptor are pretty JSON with a final newline. */
const pretty = value => JSON.stringify(value, null, 2) + '\n';
/** A cell delta shard stays readable below 500 lines, else compact, as the store writes it. */
function cellEncode(value) {
  const readable = pretty(value);
  return readable.split('\n').length - 1 < 500 ? readable : JSON.stringify(value) + '\n';
}

/**
 * The repository paths an allowance key names, by metric: an edge names both ends, an export or unknown row its file.
 *
 * @param {string} metric
 * @param {string} key
 * @returns {string[]}
 */
export function lintKeyPaths(metric, key) {
  if (metric === 'cycles') return [];
  if (key.includes('->')) return key.split('->').map(path => path.replace(/^temporary:/u, ''));
  if (metric === 'unknown') return [key.slice(0, key.indexOf(':'))];
  if (metric === 'unreachableExports') return [key.split('#')[0]];
  return [key];
}

/** True when the key names a file of the split. */
const inFamily = (family, metric, key) => lintKeyPaths(metric, key).some(path => family.has(path));

/**
 * Plan the lint baseline edit: drop every allowance naming a split file, add the measured rows, and refuse a rise.
 * The budget is the family's measured debt on main, as the cells check counts it, else its committed rows; it is
 * compared per metric over the whole family, so moving a row between siblings never pays for new debt.
 *
 * @param {string} root
 * @param {string[]} files - The original path then its siblings.
 * @param {{ report: object, base: object | null, effective: object }} measured - This tree's cell lint report, main's
 *   report (null without a main) and the current combined baseline (readCellLintBaseline).
 * @returns {{ rows: object[], writes: Map<string, string> }}
 */
export function planLintSplit(root, files, { report, base, effective }) {
  const family = new Set(files), rows = [], writes = new Map();
  const descriptorPath = join(root, CELL_BASELINE_DESCRIPTOR);
  if (!existsSync(descriptorPath)) return { rows: [{ registry: 'lint index', skipped: 'absent' }], writes };
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  const measured = Object.fromEntries(CELL_METRICS.map(metric => {
    const found = new Map();
    for (const { key, count } of report.metrics[metric]?.findings ?? []) if (inFamily(family, metric, key)) found.set(key, (found.get(key) ?? 0) + count);
    return [metric, found];
  }));
  for (const metric of CELL_METRICS) {
    const before = base ? (base.metrics[metric]?.findings ?? []).filter(({ key }) => inFamily(family, metric, key)).reduce((sum, { count }) => sum + count, 0)
      : Object.entries(effective.metrics[metric].allowances).filter(([key]) => inFamily(family, metric, key)).reduce((sum, [, count]) => sum + count, 0);
    const after = [...measured[metric].values()].reduce((sum, count) => sum + count, 0);
    if (before || after) rows.push({ registry: `lint ${metric}`, before, after, rose: after > before });
  }
  const changed = new Set();
  for (const metric of CELL_METRICS) {
    const shards = descriptor.metrics[metric].shards;
    const documents = shards.map(({ file }) => JSON.parse(readFileSync(join(root, file), 'utf8')));
    let target = -1;
    const edited = documents.map((document, index) => {
      const allowances = {};
      let touched = false;
      for (const [key, count] of Object.entries(document.allowances)) {
        if (!inFamily(family, metric, key)) { allowances[key] = count; continue; }
        touched = true;
        if (target === -1) { target = index; for (const [next, value] of measured[metric]) allowances[next] = value; }
      }
      return touched ? { ...document, allowances } : document;
    });
    if (target === -1 && measured[metric].size) {
      target = Math.max(0, edited.length - 1);
      if (!edited.length) throw new Error(`no ${metric} shard to hold the split's rows`);
      edited[target] = { ...edited[target], allowances: { ...edited[target].allowances, ...Object.fromEntries(measured[metric]) } };
    }
    edited.forEach((document, index) => {
      if (document === documents[index]) return;
      const bytes = pretty(document);
      if (bytes.split('\n').length - 1 >= 500) throw new Error(`${shards[index].file} would reach 500 lines; reshard it first`);
      writes.set(shards[index].file, bytes);
      shards[index] = { file: shards[index].file, sha256: digest(bytes) };
      changed.add(metric);
    });
    if (changed.has(metric)) descriptor.metrics[metric].count = edited.reduce((sum, document) => sum + Object.values(document.allowances).reduce((total, count) => total + count, 0), 0);
  }
  const cellDirectory = join(root, CELL_SHARDS);
  const cellFiles = existsSync(cellDirectory) ? readdirSync(cellDirectory).filter(name => name.endsWith('.json')).sort() : [];
  const cellEdits = cellFiles.map(name => {
    const { sha256, ...payload } = JSON.parse(readFileSync(join(cellDirectory, name), 'utf8'));
    let touched = false;
    for (const [metric, row] of Object.entries(payload.metrics ?? {})) {
      const remove = row.remove.filter(key => !inFamily(family, metric, key));
      const allowances = Object.fromEntries(Object.entries(row.allowances).filter(([key]) => !inFamily(family, metric, key)));
      if (remove.length !== row.remove.length || Object.keys(allowances).length !== Object.keys(row.allowances).length) touched = true;
      payload.metrics[metric] = { remove, allowances };
    }
    return { name, payload, sha256, touched };
  });
  if (!changed.size && !cellEdits.some(row => row.touched)) return { rows, writes };
  const descriptorBytes = pretty(descriptor);
  writes.set(CELL_BASELINE_DESCRIPTOR, descriptorBytes);
  const baseSha256 = digest(descriptorBytes);
  for (const { name, payload } of cellEdits) {
    const next = { ...payload, baseSha256 };
    const ordered = { version: next.version, cell: next.cell, baseSha256, metrics: next.metrics };
    writes.set(`${CELL_SHARDS}/${name}`, cellEncode({ ...ordered, sha256: digest(cellEncode(ordered)) }));
  }
  rows.push({ registry: 'lint index', rebound: cellEdits.length });
  return { rows, writes };
}
