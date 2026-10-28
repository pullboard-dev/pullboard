import { cellSourceInputs } from './cell-lint-inputs.js';
import { gitChildEnv } from './git.js';
import { gitSpawnSync } from './git-adapter.js';
/** Compute the accepted cells layout and literal graph without evaluating repository modules [CD19,CD23,CD61,CD62]. */
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importsIn } from './module-imports.js';
import { commonJsIn } from './module-imports.js';
import { repositoryImport } from './import-map.js';

/** Name the actual cell folder, without inventing a metadata registry. */
export function cellOf(file) { return /^(?:apps|packages)\/[^/]+\//u.exec(file)?.[0].slice(0, -1) ?? null; }

/** Exclude test and contract modules from production reachability roots and edges. */
export function testFile(file) { return /(?:^|\/)(?:test|tests|contract)\//u.test(file) || /\.test\.[cm]?js$/u.test(file); }

/** Read only the exact committed migration marker; working-tree files and live board state grant nothing. */
export function committedCellTransition(root) {
  const file = 'bin/cells-plan/transition.json';
  const options = { cwd: root, env: gitChildEnv(root), encoding: 'utf8' };
  const entry = gitSpawnSync(['ls-tree', '-z', 'HEAD', '--', file], options);
  if (entry.status !== 0 || !entry.stdout) return { present: false, active: false };
  if (!/^100(?:644|755) blob [a-f0-9]+\tbin\/cells-plan\/transition\.json\0$/u.test(entry.stdout)) {
    return { present: true, active: false, problem: 'transition marker must be a committed regular file' };
  }
  const source = gitSpawnSync(['show', `HEAD:${file}`], options);
  let marker;
  try { marker = JSON.parse(source.stdout); } catch { /* Invalid source is reported as named debt below. */ }
  if (source.status !== 0 || !marker || Array.isArray(marker) || Object.keys(marker).sort().join() !== 'deleteItem,version'
    || marker.version !== 1 || marker.deleteItem !== 1770) {
    return { present: true, active: false, problem: 'transition marker must name deleteItem 1770 and version 1 only' };
  }
  return { present: true, active: true };
}

/** Inventory all ordinary repository files; symlinks remain visible unknowns rather than traversed boundaries. */
export function cellInventory(root) {
  const files = new Map(), unknown = [];
  const listed = gitSpawnSync(['ls-files', '--cached', '--others', '--exclude-per-directory=.gitignore', '-z'], { cwd: root, env: gitChildEnv(root), encoding: 'utf8' });
  if (listed.status !== 0) throw new Error('cell lint inventory needs a real Git repository; initialize the private fixture or restore Git metadata');
  for (const file of [...new Set(listed.stdout.split('\0').filter(Boolean))].sort()) {
    let entry;
    try { entry = lstatSync(join(root, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; unknown.push({ file, reason: 'tracked path is missing' }); continue; }
    if (entry.isFile()) files.set(file, readFileSync(join(root, file)));
    else unknown.push({ file, reason: 'non-regular repository entry is not followed' });
  }
  const config = files.has('package.json') ? JSON.parse(files.get('package.json').toString('utf8')) : {};
  const modules = [...files.keys()].filter(file => /\.[cm]?js$/u.test(file)).sort();
  const edges = new Map(modules.map(file => [file, []]));
  const sources = modules.map(file => files.get(file).toString('utf8'));
  const parsed = importsIn(sources), common = commonJsIn(sources);
  for (const [index, file] of modules.entries()) {
    const imports = parsed[index];
    if (common[index]) unknown.push({ file, reason: 'CommonJS loader closure is unresolved' });
    for (const specifier of imports) {
      if (specifier.startsWith('node:')) continue;
      const target = repositoryImport(file, specifier, config.imports);
      if (!target || !files.has(target)) {
        unknown.push({ file, specifier, reason: target ? `missing import target ${target}` : 'unresolved import or computed loader' });
        continue;
      }
      edges.get(file).push({ target, specifier });
    }
  }
  const inputs = cellSourceInputs(modules.map((file, index) => ({ file, source: sources[index] })), files);
  for (const [file, rows] of inputs) for (const row of rows) {
    if (row.unresolved) unknown.push({ file, specifier: row.specifier, reason: row.unresolved });
    else if (!files.has(row.target)) unknown.push({ file, specifier: row.specifier, reason: `missing ${row.kind} input ${row.target}` });
    else edges.get(file).push(row);
  }
  return { files, edges, unknown };
}

/** Return each directed inter-cell edge in a strongly connected component, retaining its identity. */
export function cycleEdges(graph) {
  const result = [];
  /** Determine whether an existing target reaches its source; visited bounds cycles. */
  function reaches(from, target, seen = new Set()) {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(graph.get(from) ?? [])].some(next => reaches(next, target, seen));
  }
  for (const [from, targets] of graph) for (const target of targets) if (reaches(target, from)) result.push(`${from}->${target}`);
  return result.sort();
}

/** Validate explicit, time-bounded migration edges without evaluating code or consulting a live board. */
export function temporaryCellEdges(files, now = Date.now()) {
  const file = 'bin/cells-plan/temporary-edges.json';
  if (!files.has(file)) return { edges: [], problems: [] };
  let document;
  try { document = JSON.parse(files.get(file).toString('utf8')); }
  catch { return { edges: [], problems: [`${file}: invalid JSON`] }; }
  if (document?.version !== 1 || !Array.isArray(document.edges)) {
    return { edges: [], problems: [`${file}: expected version 1 and an edges array`] };
  }
  const edges = [], problems = [], seen = new Set();
  for (const [index, row] of document.edges.entries()) {
    const name = `${file}[${index}]: ${row?.importer ?? '?'} -> ${row?.target ?? '?'}`;
    /** Accept canonical relative module names, never traversal or filesystem locations. */
    const path = value => typeof value === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[cm]?js$/u.test(value)
      && !value.split('/').some(part => part === '.' || part === '..');
    if (!row || !path(row.importer) || !path(row.target)) {
      problems.push(`${name}: importer and target must name repository module paths`); continue;
    }
    if (!Number.isSafeInteger(row.contractItem) || row.contractItem < 1) {
      problems.push(`${name}: a positive contract item is required`); continue;
    }
    const expiry = typeof row.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(row.expires)
      ? Date.parse(row.expires + 'T00:00:00.000Z') : NaN;
    if (!Number.isFinite(expiry) || new Date(expiry).toISOString().slice(0, 10) !== row.expires) {
      problems.push(`${name}: expires must be a real UTC date (YYYY-MM-DD)`); continue;
    }
    const key = `${row.importer}->${row.target}`;
    if (seen.has(key)) { problems.push(`${name}: duplicate temporary edge`); continue; }
    seen.add(key);
    edges.push({ importer: row.importer, target: row.target, contractItem: row.contractItem, expires: row.expires });
    if (expiry <= now) problems.push(`${name}: expired ${row.expires}; remove it through contract #${row.contractItem}`);
  }
  return { edges, problems };
}
