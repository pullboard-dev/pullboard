/** Audit-only branch aggregation from Node's observed coverage events; absent files stay unknown [C7]. */
import {
  relative,
  sep,
} from 'node:path';

/** Assign a file to its deepest declared package boundary. */
function packageOf(file, packages) {
  return packages.filter(row => !row.prefix || file.startsWith(row.prefix + '/'))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.name ?? null;
}

/** Normalize actual Node coverage paths without admitting files outside the audited source. */
function coveragePath(root, path) {
  if (typeof path !== 'string') return null;
  const file = relative(root, path).split(sep).join('/');
  return file && file !== '..' && !file.startsWith('../') && !file.startsWith('/') ? file : null;
}

/**
 * Union actual branch hits across shards, rather than adding percentages or counting a shared
 * branch twice. A changed branch layout or runtime is unknown, never a fabricated complete result.
 * `expectedFiles` is the audited product inventory, not merely the modules that happened to load.
 */
export function packageBranchCoverage(samples, { expectedFiles, packages }) {
  const expected = new Set(expectedFiles);
  const files = new Map();
  const invalid = new Set();
  for (const sample of samples) {
    if (typeof sample?.runtime !== 'string' || typeof sample?.summary?.workingDirectory !== 'string'
      || !Array.isArray(sample.summary.files)) throw new TypeError('missing observed audit coverage');
    for (const observed of sample.summary.files) {
      const file = coveragePath(sample.summary.workingDirectory, observed.path);
      if (!expected.has(file)) continue;
      if (!Array.isArray(observed.branches) || observed.branches.length !== observed.totalBranchCount
        || observed.branches.some(branch => !Number.isSafeInteger(branch.line) || branch.line < 1
          || !Number.isFinite(branch.count) || branch.count < 0)) { invalid.add(file); continue; }
      const layout = observed.branches.map(branch => branch.line);
      const prior = files.get(file);
      if (prior && (prior.runtime !== sample.runtime || JSON.stringify(prior.layout) !== JSON.stringify(layout))) {
        invalid.add(file); continue;
      }
      const hits = prior?.hits ?? new Set();
      observed.branches.forEach((branch, index) => { if (branch.count > 0) hits.add(index); });
      files.set(file, { runtime: sample.runtime, layout, hits });
    }
  }
  const rows = new Map(packages.map(row => [row.name, { package: row.name, branches: 0, covered: 0, missing: [], invalid: [] }]));
  for (const file of expected) {
    const owner = packageOf(file, packages);
    if (!owner || !rows.has(owner)) throw new TypeError(`no audit package owns ${file}`);
    const row = rows.get(owner), measured = files.get(file);
    if (invalid.has(file)) row.invalid.push(file);
    else if (!measured) row.missing.push(file);
    else { row.branches += measured.layout.length; row.covered += measured.hits.size; }
  }
  return [...rows.values()].map(row => ({ ...row, missing: row.missing.sort(), invalid: row.invalid.sort(),
    complete: !row.missing.length && !row.invalid.length,
    percent: row.missing.length || row.invalid.length ? null : row.branches ? 100 * row.covered / row.branches : 100 }));
}
