/** The cells plan model: the plan files' names, shape, reader, writer and path placement [C7,D3,CD60,CD64]. */
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { tryGit as realTryGit } from '../../../git/index.js';
import { cellExistsSync as existsSync } from './cell/snapshot.js';
import { cellLstatSync as lstatSync } from './cell/snapshot.js';
import { cellReaddirSync as readdirSync } from './cell/snapshot.js';
import { cellReadFileSync as readFileSync } from './cell/snapshot.js';
import { cellInventory } from './cell/lint/inventory.js';
import { importsIn } from './module/imports.js';
import { commonJsIn } from './module/imports.js';
import { buildCellsPlan } from './cells/plan.js';
import { inPlanScope } from './cells/plan.js';
import { formatJson } from '../logic/format-json.js';
import { entryPlacementProblems } from './cells-plan-placement.js';
import { ownedStayProblems } from './cells-plan-placement.js';
import { retiredProblems } from './cells-plan-placement.js';
import { storeName } from './store-names.js';

export { formatJson };
export const PLAN_FILE = 'packages/codemap/data/plan/cells.json';
export const PLAN_DIR = 'packages/codemap/data/plan';
export const SEED_FILE = 'packages/codemap/data/plan/seed.json';

/** Read the dry run's map, stored grouped by cell so the copy stays a few dozen lines, as a path-to-cell seed. */
export function readSeed(root) {
  const stored = JSON.parse(readFileSync(join(root, SEED_FILE), 'utf8'));
  /** Flatten one cell-to-paths object back into the dry run's path-to-cell shape. */
  const flat = grouped => Object.fromEntries(Object.entries(grouped ?? {}).flatMap(([cell, paths]) => paths.map(path => [path, cell])));
  return { ...stored, files: flat(stored.cells), tests: flat(stored.tests) };
}

/** Name one cell's shard file, ordered so a directory listing reads leaf-first. */
export function shardFile(cell) {
  return `${PLAN_DIR}/${String(cell.order).padStart(2, '0')}-${storeName(cell.name.replace(':', '-'))}`;
}

/** Every placed path belongs to exactly one recognized source bucket. */
function requirePlacementSources(cell) {
  if (cell.paths.some(row => !['seed', 'rule', 'imports'].includes(row[2]))) throw new Refused('CELLS_UNPLACED', `${cell.name} has a path without a known placement source; resolve that path before writing the plan`);
}

/** Derive a cell's placement counts from its actual rows, never a stored summary. */
function placementCounts(cell) {
  requirePlacementSources(cell);
  return Object.fromEntries(['seed', 'rule', 'imports'].map(via => [via, cell.paths.filter(row => row[2] === via).length]));
}

/** Derive all plan counters from the same cell rows and explicit stays the reader returns. */
function planCounts(cells, stays) {
  for (const cell of cells) for (const cut of cell.cuts) {
    if (!Number.isSafeInteger(cut.imports) || cut.imports < 0) throw new Refused('CELLS_PLAN_COUNTS', `${cell.name} has a cut without a nonnegative integer import count`);
  }
  return {
    cells: cells.length,
    movedPaths: cells.reduce((sum, cell) => sum + cell.paths.length, 0),
    stays: stays.length,
    placedBy: Object.fromEntries(['seed', 'rule', 'imports'].map(via => [via, cells.reduce((sum, cell) => sum + cell.placedBy[via], 0)])),
    shims: cells.reduce((sum, cell) => sum + cell.reexports.length, 0),
    cutImports: cells.reduce((sum, cell) => sum + cell.cuts.reduce((sum, row) => sum + row.imports, 0), 0),
    cutEdges: cells.reduce((sum, cell) => sum + cell.cuts.length, 0),
  };
}

/** The plan JSON files writePlan never prunes, for a plan whose cells are these. */
function keptPlanFiles(cells) {
  return new Set([SEED_FILE, `${PLAN_DIR}/temporary-edges.json`, `${PLAN_DIR}/transition.json`, ...cells.map(cell => shardFile(cell))]);
}

/**
 * Every file writing this plan would change for one cell: the index, that cell's shard, and each JSON file in the plan
 * folder the write would prune. A shim removal checks these against its lane before it mutates anything.
 */
export function planWrites(root, plan, name) {
  const keep = keptPlanFiles(plan.cells), cell = plan.cells.find(row => row.name === name);
  const pruned = existsSync(join(root, PLAN_DIR)) ? readdirSync(join(root, PLAN_DIR)).filter(file => file.endsWith('.json') && !keep.has(`${PLAN_DIR}/${file}`)).map(file => `${PLAN_DIR}/${file}`) : [];
  return [PLAN_FILE, ...(cell ? [shardFile(cell)] : []), ...pruned.sort()];
}

/**
 * Write the plan as an index plus one shard per cell, removing shards a regenerated plan no longer names.
 * The path-map reader is the caller's, so a snapshot-aware caller keeps its own; every dependency defaults.
 */
export function writePlan(root, plan, { readPathMap } = {}) {
  const entries = entryPlacementProblems(root, plan, undefined, undefined, readPathMap);
  if (entries.length) throw new Refused('CELLS_ENTRY', entries.join('; '));
  const owned = ownedStayProblems(plan);
  if (owned.length) throw new Refused('CELLS_STAY_OWNER', `${owned.join('; ')}; name an existing cell with --owner`);
  const retired = retiredProblems(root, plan);
  if (retired.length) throw new Refused('CELLS_PLAN_RETIRED', retired.join('; '));
  // Persist authoritative rows; readers derive summaries from the exact rows they return.
  const cells = plan.cells.map(cell => {
    requirePlacementSources(cell);
    const { placedBy: _cachedPlacement, ...rows } = cell;
    return rows;
  });
  mkdirSync(join(root, PLAN_DIR), { recursive: true });
  const shards = cells.map(cell => [shardFile(cell), cell]);
  const keep = keptPlanFiles(cells);
  for (const name of readdirSync(join(root, PLAN_DIR))) if (name.endsWith('.json') && !keep.has(`${PLAN_DIR}/${name}`)) rmSync(join(root, PLAN_DIR, name));
  for (const [file, cell] of shards) {
    // A shard whose data is unchanged keeps its bytes, so one row's edit never reformats an unrelated cell.
    let current = null;
    try { current = JSON.parse(readFileSync(join(root, file), 'utf8')); } catch { current = null; }
    if (current === null || JSON.stringify(current) !== JSON.stringify(cell)) writeFileSync(join(root, file), formatJson(cell) + '\n');
  }
  const { totals: _cachedTotals, ...metadata } = plan;
  const index = { ...metadata, cells: cells.map(cell => ({ order: cell.order, name: cell.name, file: shardFile(cell) })) };
  writeFileSync(join(root, PLAN_FILE), JSON.stringify(index, null, 2) + '\n');
}

/** Read the committed plan back as one object, refusing an index whose shard is missing. */
export function readPlan(root, read = file => readFileSync(join(root, file), 'utf8')) {
  const index = JSON.parse(read(PLAN_FILE));
  const cells = index.cells.map(row => {
    let source;
    try { source = read(row.file); } catch { throw new Refused('CELLS_PLAN_SHARD', `${row.file} is missing; regenerate with node packages/codemap/src/io/cells/scripts/plan.js --write`); }
    const cell = JSON.parse(source);
    return { ...cell, placedBy: placementCounts(cell) };
  });
  return { ...index, totals: planCounts(cells, index.stays), cells };
}

/** Append one explicit placement; preserve every existing row, cut, contract and ordering decision. */
export function placePath(root, file, { cell, stay = false, part = 'shell', entry = false, owner } = {}, deps = {}) {
  const tryGit = deps.tryGit ?? realTryGit;
  if (typeof file !== 'string' || !inPlanScope(file) || file.split('/').some(piece => !piece || piece === '.' || piece === '..')
    || /[\0\r\n\\]/u.test(file) || stay === Boolean(cell) || typeof entry !== 'boolean' || !['core', 'shell'].includes(part)) {
    throw new Refused('CELLS_UNPLACED', 'use --place <in-scope path> with exactly one --cell <existing cell> or --stay');
  }
  const tracked = tryGit(root, ['ls-files', '--error-unmatch', '--', file]);
  if (tracked.status !== 0 || !lstatSync(join(root, file)).isFile()) throw new Refused('CELLS_UNPLACED', `stage a regular source file before placing it: ${file}`);
  const plan = readPlan(root);
  if (owner !== undefined) return ownStay(root, plan, file, { stay, entry, owner }, deps);
  if (entry) {
    const destination = plan.cells.find(row => row.name === cell);
    if (!destination?.name.startsWith('app:') || stay || part !== 'shell') throw new Refused('CELLS_ENTRY', 'a process entry needs the shell of an existing app cell');
    if ((plan.entries ?? []).some(row => row.path === file)) throw new Refused('CELLS_ENTRY', `${file} already has explicit process ownership`);
    if (file.startsWith('bin/')) {
      if (!plan.stays.some(row => row.path === file)) plan.stays.push({ path: file, reason: 'process entry keeps its public executable path' });
    } else {
      const target = `${destination.root}/src/${part === 'core' ? 'logic' : 'io'}/${file.slice(file.indexOf('/') + 1)}`;
      if (plan.cells.some(row => row.paths.some(([from, to]) => from !== file && to === target))) throw new Refused('CELLS_ENTRY', `entry target already belongs to another path: ${target}`);
      for (const row of plan.cells) {
        row.paths = row.paths.filter(([from]) => from !== file);
        row.reexports = row.reexports.filter(path => path !== file);
      }
      plan.stays = plan.stays.filter(row => row.path !== file);
      destination.paths.push([file, target, 'rule']);
    }
    plan.entries = [...(plan.entries ?? []), { path: file, cell }];
    writePlan(root, plan, deps);
    return plan;
  }
  const assigned = plan.cells.flatMap(entry => entry.paths).some(([from, to]) => from === file || to === file)
    || plan.stays.some(row => row.path === file);
  if (assigned) throw new Refused('CELLS_UNPLACED', `${file} is already placed; retain its existing plan row`);
  if (stay) plan.stays.push({ path: file, reason: 'explicit bounded placement: stays in place during the move' });
  else {
    const entry = plan.cells.find(entry => entry.name === cell);
    if (!entry || file.startsWith('bin/')) throw new Refused('CELLS_UNPLACED', `choose an existing cell, or --stay for bin/: ${cell}`);
    const target = `${entry.root}/src/${part === 'core' ? 'logic' : 'io'}/${file.slice(file.indexOf('/') + 1)}`;
    if (plan.cells.some(row => row.paths.some(([from, to]) => from === target || to === target))) throw new Refused('CELLS_UNPLACED', `the placement target already belongs to a path: ${target}`);
    entry.paths.push([file, target, 'rule']);
  }
  writePlan(root, plan, deps);
  return plan;
}

/**
 * Give a stay an owner cell: the file keeps its path, and the plan check and cut walk count it as that cell's file.
 * Why: deployed entries such as apps/relay/src/io/deploy/server.mjs keep their path, yet belong to the app that serves them (#2576).
 */
function ownStay(root, plan, file, { stay, entry, owner }, deps) {
  if (!stay || entry || typeof owner !== 'string') throw new Refused('CELLS_STAY_OWNER', 'use --stay <path> --owner <cell>');
  if (!plan.cells.some(row => row.name === owner)) throw new Refused('CELLS_STAY_OWNER', `choose an existing cell for --owner: ${owner}`);
  if (plan.cells.some(row => row.paths.some(([from, to]) => from === file || to === file))) {
    throw new Refused('CELLS_STAY_OWNER', `${file} is planned to move; only a stay can have an owner`);
  }
  const row = plan.stays.find(value => value.path === file);
  if (row?.owner !== undefined && row.owner !== owner) throw new Refused('CELLS_STAY_OWNER', `${file} is already owned by ${row.owner}; retain its existing owner`);
  if (row) row.owner = owner;
  else plan.stays.push({ path: file, reason: 'explicit bounded placement: stays in place during the move', owner });
  writePlan(root, plan, deps);
  return plan;
}

/** Compute the plan from a checkout's tracked files and real import edges, at its HEAD. */
export function computePlan(root, { tryGit = realTryGit } = {}) {
  const { files, edges } = cellInventory(root, { importsIn, commonJsIn });
  const seed = readSeed(root);
  const head = tryGit(root, ['rev-parse', 'HEAD']);
  const paths = [...files.keys()].filter(inPlanScope).sort();
  const sources = new Map([...files].filter(([file]) => /\.[cm]?js$/u.test(file)).map(([file, bytes]) => [file, bytes.toString('utf8')]));
  return buildCellsPlan({ paths, edges, sources, seed, base: head.status === 0 ? head.stdout.trim() : null });
}
