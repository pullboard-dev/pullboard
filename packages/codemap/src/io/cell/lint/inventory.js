import { cellSourceInputs } from './inputs.js';
import { gitChildEnv } from '../../../../../git/index.js';
import { gitSpawnSync } from '../../../../../git/index.js';
import {
  cellLstatSync,
  cellReadFileSync,
  cellSourceSnapshot,
} from '../snapshot.js';
/** Compute the accepted cells layout and literal graph without evaluating repository modules [CD19,CD23,CD61,CD62]. */
import { join } from 'node:path';
import { repositoryImport } from '../../../logic/imports.js';

/** Name the actual cell folder, without inventing a metadata registry. */
export function cellOf(file) { return /^(?:apps|packages)\/[^/]+\//u.exec(file)?.[0].slice(0, -1) ?? null; }

/** Exclude test and contract modules from production reachability roots and edges. */
export function testFile(file) { return file === 'packages/testkit/index.js' || file.startsWith('packages/testkit/src/') || !/(?:^|\/)src\//u.test(file) && /(?:^|\/)(?:test|tests|contract|journeys)\//u.test(file) || /\.test\.[cm]?js$/u.test(file); }

/** Read only the exact committed migration marker; working-tree files and live board state grant nothing. */
export function committedCellTransition(root) {
  const file = 'packages/codemap/data/plan/transition.json';
  const snapshot = cellSourceSnapshot(root);
  if (snapshot) {
    const entry = snapshot.entries.get(file);
    if (!entry) return { present: false, active: false };
    const regular = entry.mode === '100644' || entry.mode === '100755' || entry.mode === 0o100644 || entry.mode === 0o100755;
    if (!regular) return { present: true, active: false, problem: 'transition marker must be a committed regular file' };
    const bytes = snapshot.files.get(file);
    if (!bytes) return { present: true, active: false, problem: 'transition marker bytes are unavailable from the sealed source snapshot' };
    let marker;
    try { marker = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { /* Invalid source is reported as named debt below. */ }
    if (!marker || Array.isArray(marker) || Object.keys(marker).sort().join() !== 'deleteItem,version'
      || marker.version !== 1 || marker.deleteItem !== 1770) {
      return { present: true, active: false, problem: 'transition marker must name deleteItem 1770 and version 1 only' };
    }
    return { present: true, active: true };
  }
  const options = { cwd: root, env: gitChildEnv(root), encoding: 'utf8' };
  const entry = gitSpawnSync(['ls-tree', '-z', 'HEAD', '--', file], options);
  if (entry.status !== 0 || !entry.stdout) return { present: false, active: false };
  if (!/^100(?:644|755) blob [a-f0-9]+\tpackages\/codemap\/data\/plan\/transition\.json\0$/u.test(entry.stdout)) {
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

/** How many full inventories this process has built; a sweep that reuses one proves it with this count (#2232). */
let inventoryBuilds = 0;

/**
 * The number of full cell inventories built so far in this process.
 *
 * @returns {number}
 */
export function inventoryBuildCount() { return inventoryBuilds; }

/**
 * Whether a changed path alters how every module is read, so only a full census is canonical: package.json holds the
 * import map, and the kernel front door and discovery.js decide which command folders count as inputs.
 *
 * @param {Iterable<string>} changed
 * @returns {boolean}
 */
export function needsFullCensus(changed) {
  return [...changed].some(file => file === 'package.json' || file === 'packages/kernel/index.js' || file === 'discovery.js' || file.endsWith('/discovery.js'));
}

/** Name the file a "missing import target" or "missing <kind> input" row waits for, so an added file can satisfy it. */
function missingTarget(row) { return /^missing (?:import target|\w+ input) (.+)$/u.exec(row.reason ?? '')?.[1] ?? null; }

/**
 * Bring an inventory up to date for the changed paths only: changed and added files are read and parsed, deleted
 * ones leave, and only the modules whose result depends on the file set are parsed again (importers of a deleted
 * file, modules waiting on an added one, and command-folder discoverers). Why: the cells check must cost in
 * proportion to the diff, never the repository, and almost every item adds or deletes a file (#2531).
 *
 * @param {string} root
 * @param {any} parsers
 * @param {{ files: Map<string, Buffer>, edges: Map<string, any[]>, unknown: any[] }} prior
 * @param {Iterable<string>} changed
 * @returns {{ files: Map<string, Buffer>, edges: Map<string, any[]>, unknown: any[] }}
 */
export function updateCellInventory(root, parsers, prior, changed) {
  const paths = [...new Set(changed)].sort();
  if (needsFullCensus(paths)) return cellInventory(root, parsers);
  const files = new Map(prior.files), edges = new Map(prior.edges), touched = new Set(paths);
  let unknown = prior.unknown.filter(row => !touched.has(row.file));
  const added = new Set(), removed = new Set();
  for (const file of paths) {
    let entry = null;
    try { entry = cellLstatSync(join(root, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const was = files.has(file);
    if (entry?.isFile()) { files.set(file, cellReadFileSync(join(root, file))); if (!was) added.add(file); continue; }
    files.delete(file);
    edges.delete(file);
    if (was) removed.add(file);
    if (entry) unknown.push({ file, reason: 'non-regular repository entry is not followed' });
  }
  const config = files.has('package.json') ? JSON.parse(files.get('package.json').toString('utf8')) : {};
  const reparse = new Set(paths.filter(file => files.has(file) && /\.[cm]?js$/u.test(file)));
  if (added.size || removed.size) {
    for (const [file, rows] of edges) if (rows.some(row => removed.has(row.target))) reparse.add(file);
    for (const row of unknown) if (added.has(missingTarget(row))) reparse.add(row.file);
    for (const [file, bytes] of files) if (/\.[cm]?js$/u.test(file) && bytes.includes('COMMAND_CANDIDATE')) reparse.add(file);
  }
  const modules = [...reparse].filter(file => files.has(file)).sort(), again = new Set(modules);
  unknown = unknown.filter(row => !again.has(row.file));
  const sources = modules.map(file => files.get(file).toString('utf8'));
  const parsed = parsers.importsIn(sources), common = parsers.commonJsIn(sources);
  for (const [index, file] of modules.entries()) {
    const rows = [];
    if (common[index]) unknown.push({ file, reason: 'CommonJS loader closure is unresolved' });
    for (const specifier of parsed[index]) {
      if (specifier.startsWith('node:')) continue;
      const target = repositoryImport(file, specifier, config.imports);
      if (!target || !files.has(target)) {
        unknown.push({ file, specifier, reason: target ? `missing import target ${target}` : 'unresolved import or computed loader' });
        continue;
      }
      rows.push({ target, specifier });
    }
    edges.set(file, rows);
  }
  const inputs = cellSourceInputs(modules.map((file, index) => ({ file, source: sources[index] })), files);
  for (const [file, rows] of inputs) for (const row of rows) {
    if (row.unresolved) unknown.push({ file, specifier: row.specifier, reason: row.unresolved });
    else if (!files.has(row.target)) unknown.push({ file, specifier: row.specifier, reason: `missing ${row.kind} input ${row.target}` });
    else edges.get(file).push(row);
  }
  return { files, edges, unknown };
}

/** Parse every tracked module, naming the first file that does not compile so the refusal says where to look. */
function parseTracked(importsIn, modules, sources) {
  try { return importsIn(sources); }
  catch (error) {
    if (error.message !== 'source does not compile as an ES module') throw error;
    for (const [index, file] of modules.entries()) {
      try { importsIn([sources[index]]); }
      catch (failure) { if (failure.message === error.message) throw new Error(`${file}: ${error.message}`); throw failure; }
    }
    throw error;
  }
}

/** Inventory the files Git tracks, staged changes included, so ignored or untracked scratch never reaches a lint; symlinks remain visible unknowns rather than traversed boundaries. */
export function cellInventory(root, parsers) {
  inventoryBuilds += 1;
  if (typeof parsers?.importsIn !== 'function' || typeof parsers?.commonJsIn !== 'function') throw new TypeError('cell inventory needs explicit module parser operations');
  const { importsIn, commonJsIn } = parsers;
  const files = new Map(), unknown = [];
  const snapshot = cellSourceSnapshot(root);
  let listedPaths;
  if (snapshot) listedPaths = [...snapshot.entries.keys()].sort();
  else {
    const listed = gitSpawnSync(['ls-files', '--cached', '-z'], { cwd: root, env: gitChildEnv(root), encoding: 'utf8' });
    if (listed.status !== 0) throw new Error('cell lint inventory needs a real Git repository; initialize the private fixture or restore Git metadata');
    listedPaths = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort();
  }
  for (const file of listedPaths) {
    if (snapshot) {
      const entry = snapshot.entries.get(file);
      if (entry && (typeof entry.mode === 'string' ? entry.mode === '040000' : entry.mode === 0o040000)) continue;
      const regular = entry && (entry.mode === '100644' || entry.mode === '100755' || entry.mode === 0o100644 || entry.mode === 0o100755);
      if (!regular) { unknown.push({ file, reason: 'non-regular repository entry is not followed' }); continue; }
      const bytes = snapshot.files.get(file);
      if (!bytes) { unknown.push({ file, reason: 'tracked path blob bytes are unavailable in the sealed snapshot' }); continue; }
      files.set(file, Buffer.from(bytes));
      continue;
    }
    let entry;
    try { entry = cellLstatSync(join(root, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; unknown.push({ file, reason: 'tracked path is missing' }); continue; }
    if (entry.isFile()) files.set(file, cellReadFileSync(join(root, file)));
    else unknown.push({ file, reason: 'non-regular repository entry is not followed' });
  }
  const config = files.has('package.json') ? JSON.parse(files.get('package.json').toString('utf8')) : {};
  const modules = [...files.keys()].filter(file => /\.[cm]?js$/u.test(file)).sort();
  const edges = new Map(modules.map(file => [file, []]));
  const sources = modules.map(file => files.get(file).toString('utf8'));
  const parsed = parseTracked(importsIn, modules, sources), common = commonJsIn(sources);
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
  const file = 'packages/codemap/data/plan/temporary-edges.json';
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
