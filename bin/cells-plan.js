#!/usr/bin/env node
import { recordToolCommand } from '../packages/git/index.js';
/** Write, check or file the cells move plan, or check one cell's move against it [D3,CD60,CD64]. */
import { importsIn } from '../packages/gate/index.js';
import { commonJsIn } from '../packages/gate/index.js';
import { withParseScope } from '../packages/gate/index.js';
import { formatJson } from '../packages/merge/index.js';
import { cellExistsSync as existsSync } from '../packages/codemap/index.js';
import { cellLstatSync as lstatSync } from '../packages/codemap/index.js';
import { mkdirSync } from 'node:fs';
import { cellReaddirSync as readdirSync } from '../packages/codemap/index.js';
import { cellReadFileSync as readFileSync } from '../packages/codemap/index.js';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { posix } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellInventory } from '../packages/codemap/index.js';
import { temporaryCellEdges } from '../packages/codemap/index.js';
import { cellLintReport } from '../packages/codemap/index.js';
import { cellLintGrowth } from '../packages/codemap/index.js';
import { mainCellLintReport } from '../packages/codemap/index.js';
import { buildCellsPlan } from '../packages/codemap/index.js';
import { inPlanScope } from '../packages/codemap/index.js';
import { moveHistoryPlacement } from '../packages/codemap/index.js';
import { engineLeafPlacement } from '../packages/codemap/index.js';
import { readPathMap } from './cells-snapshot-git.js';
import { mappedPath } from '../packages/codemap/index.js';
import { tryGit } from './cells-snapshot-git.js';
import { Refused } from '../packages/kernel/index.js';
import { lex } from '../packages/kernel/index.js';
import { runnerWorkerFiles } from './cells-move-closure.js';
import { retainEnginePaths } from './cells-engine-stays.js';
import { cachedCellsRun } from '../src/cells-cache.js';
import { checkCuts } from './cells-plan-cuts.js';
import { fileCuts } from './cells-plan-cuts.js';
import { refreshPlanCuts } from '../packages/codemap/index.js';
import { retiredProblems } from './cells-plan-cuts.js';
import { entryPlacementProblems } from './cells-plan-cuts.js';
import { ownedStayProblems } from './cells-plan-cuts.js';
import { fixtureSourceEdits } from './cells-move-fixtures.js';
import { removeShims } from './cells-remove-shims.js';
import { shimReport } from './cells-remove-shims.js';
import { writeShimHandoff } from './cells-remove-shims.js';
import {
  readMoveDataReads,
  staleDataReads,
} from './cells-data-reads.js';
import { pureFrontDoorProblems } from './cells-pure-front-door.js';
import { moveDeclarationFiles } from './cells-move-closure.js';

import { createFixtureMemo } from '../packages/codemap/index.js';
import { checkCommandDefinition } from '../packages/git/index.js';
import { receiptDigest } from '../packages/git/index.js';
import { foreignNodeOptions } from '../packages/gate/index.js';
import { cellsCacheDirectory } from './cells-inventory-cache.js';
import { publishCacheEntry } from './cells-inventory-cache.js';
import { placeTests } from './cells-test-placement.js';
import { planTestMove } from './cells-test-placement.js';
import { applyTestMove } from './cells-test-placement.js';

/** Key source observations by the actual analyzer's portable import closure, independently of the job folder. */
function fixtureAnalyzerDigest() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  return receiptDigest({ node: process.version, files: checkCommandDefinition(root, [], [fileURLToPath(new URL('./cells-move-fixtures.js', import.meta.url))])
    .map(entry => [entry.path, entry.mode, entry.digest]) });
}
const { rememberedFixtureEdits, saveFixtureEdits, treeBlobs, baseUnsupported, unsupportedSite } = createFixtureMemo({
  fixtureSourceEdits, cellsCacheDirectory, publishCacheEntry, analyzerDigest: fixtureAnalyzerDigest,
  eligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS),
});

export const PLAN_FILE = 'bin/cells-plan.json';
export const PLAN_DIR = 'bin/cells-plan';
export const SEED_FILE = 'bin/cells-plan/seed.json';

/** Read the dry run's map, stored grouped by cell so the copy stays a few dozen lines, as a path-to-cell seed. */
export function readSeed(root) {
  const stored = JSON.parse(readFileSync(join(root, SEED_FILE), 'utf8'));
  /** Flatten one cell-to-paths object back into the dry run's path-to-cell shape. */
  const flat = grouped => Object.fromEntries(Object.entries(grouped ?? {}).flatMap(([cell, paths]) => paths.map(path => [path, cell])));
  return { ...stored, files: flat(stored.cells), tests: flat(stored.tests) };
}

export { formatJson } from '../packages/merge/index.js';

/** Name one cell's shard file, ordered so a directory listing reads leaf-first. */
export function shardFile(cell) {
  return `${PLAN_DIR}/${String(cell.order).padStart(2, '0')}-${cell.name.replace(':', '-')}.json`;
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

/** Write the plan as an index plus one shard per cell, removing shards a regenerated plan no longer names. */
export function writePlan(root, plan) {
  const entries = entryPlacementProblems(root, plan);
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
    try { source = read(row.file); } catch { throw new Refused('CELLS_PLAN_SHARD', `${row.file} is missing; regenerate with node bin/cells-plan.js --write`); }
    const cell = JSON.parse(source);
    return { ...cell, placedBy: placementCounts(cell) };
  });
  return { ...index, totals: planCounts(cells, index.stays), cells };
}

/** Append one explicit placement; preserve every existing row, cut, contract and ordering decision. */
export function placePath(root, file, { cell, stay = false, part = 'shell', entry = false, owner } = {}) {
  if (typeof file !== 'string' || !inPlanScope(file) || file.split('/').some(piece => !piece || piece === '.' || piece === '..')
    || /[\0\r\n\\]/u.test(file) || stay === Boolean(cell) || typeof entry !== 'boolean' || !['core', 'shell'].includes(part)) {
    throw new Refused('CELLS_UNPLACED', 'use --place <in-scope path> with exactly one --cell <existing cell> or --stay');
  }
  const tracked = tryGit(root, ['ls-files', '--error-unmatch', '--', file]);
  if (tracked.status !== 0 || !lstatSync(join(root, file)).isFile()) throw new Refused('CELLS_UNPLACED', `stage a regular source file before placing it: ${file}`);
  const plan = readPlan(root);
  if (owner !== undefined) return ownStay(root, plan, file, { stay, entry, owner });
  if (entry) {
    const destination = plan.cells.find(row => row.name === cell);
    if (!destination?.name.startsWith('app:') || stay || part !== 'shell') throw new Refused('CELLS_ENTRY', 'a process entry needs the shell of an existing app cell');
    if ((plan.entries ?? []).some(row => row.path === file)) throw new Refused('CELLS_ENTRY', `${file} already has explicit process ownership`);
    if (file.startsWith('bin/')) {
      if (!plan.stays.some(row => row.path === file)) plan.stays.push({ path: file, reason: 'process entry keeps its public executable path' });
    } else {
      const target = `${destination.root}/src/${part}/${file.slice(file.indexOf('/') + 1)}`;
      if (plan.cells.some(row => row.paths.some(([from, to]) => from !== file && to === target))) throw new Refused('CELLS_ENTRY', `entry target already belongs to another path: ${target}`);
      for (const row of plan.cells) {
        row.paths = row.paths.filter(([from]) => from !== file);
        row.reexports = row.reexports.filter(path => path !== file);
      }
      plan.stays = plan.stays.filter(row => row.path !== file);
      destination.paths.push([file, target, 'rule']);
    }
    plan.entries = [...(plan.entries ?? []), { path: file, cell }];
    writePlan(root, plan);
    return plan;
  }
  const assigned = plan.cells.flatMap(entry => entry.paths).some(([from, to]) => from === file || to === file)
    || plan.stays.some(row => row.path === file);
  if (assigned) throw new Refused('CELLS_UNPLACED', `${file} is already placed; retain its existing plan row`);
  if (stay) plan.stays.push({ path: file, reason: 'explicit bounded placement: stays in place during the move' });
  else {
    const entry = plan.cells.find(entry => entry.name === cell);
    if (!entry || file.startsWith('bin/')) throw new Refused('CELLS_UNPLACED', `choose an existing cell, or --stay for bin/: ${cell}`);
    const target = `${entry.root}/src/${part}/${file.slice(file.indexOf('/') + 1)}`;
    if (plan.cells.some(row => row.paths.some(([from, to]) => from === target || to === target))) throw new Refused('CELLS_UNPLACED', `the placement target already belongs to a path: ${target}`);
    entry.paths.push([file, target, 'rule']);
  }
  writePlan(root, plan);
  return plan;
}

/**
 * Give a stay an owner cell: the file keeps its path, and the plan check and cut walk count it as that cell's file.
 * Why: deployed entries such as relay/server.mjs keep their path, yet belong to the app that serves them (#2576).
 */
function ownStay(root, plan, file, { stay, entry, owner }) {
  if (!stay || entry || typeof owner !== 'string') throw new Refused('CELLS_STAY_OWNER', 'use --stay <path> --owner <cell>');
  if (!plan.cells.some(row => row.name === owner)) throw new Refused('CELLS_STAY_OWNER', `choose an existing cell for --owner: ${owner}`);
  if (plan.cells.some(row => row.paths.some(([from, to]) => from === file || to === file))) {
    throw new Refused('CELLS_STAY_OWNER', `${file} is planned to move; only a stay can have an owner`);
  }
  const row = plan.stays.find(value => value.path === file);
  if (row?.owner !== undefined && row.owner !== owner) throw new Refused('CELLS_STAY_OWNER', `${file} is already owned by ${row.owner}; retain its existing owner`);
  if (row) row.owner = owner;
  else plan.stays.push({ path: file, reason: 'explicit bounded placement: stays in place during the move', owner });
  writePlan(root, plan);
  return plan;
}

/** Compute the plan from a checkout's tracked files and real import edges, at its HEAD. */
export function computePlan(root) {
  const { files, edges } = cellInventory(root, { importsIn, commonJsIn });
  const seed = readSeed(root);
  const head = tryGit(root, ['rev-parse', 'HEAD']);
  const paths = [...files.keys()].filter(inPlanScope).sort();
  const sources = new Map([...files].filter(([file]) => /\.[cm]?js$/u.test(file)).map(([file, bytes]) => [file, bytes.toString('utf8')]));
  return buildCellsPlan({ paths, edges, sources, seed, base: head.status === 0 ? head.stdout.trim() : null });
}

/** Name the in-scope paths at HEAD the committed plan does not place, so drift is reported rather than guessed. */
export function unplanned(root, plan, inventory) {
  const retired = retiredProblems(root, plan, inventory);
  if (retired.length) throw new Refused('CELLS_PLAN_RETIRED', retired.join('; '));
  const map = readPathMap(root);
  const known = new Set();
  for (const cell of plan.cells) for (const [from, to] of cell.paths) { known.add(from); known.add(to); known.add(mappedPath(map, from)); }
  for (const row of plan.stays) known.add(row.path);
  const listed = tryGit(root, ['ls-files']);
  if (listed.status !== 0) throw new Refused('CELLS_PLAN_GIT', 'run the plan check inside a Git checkout');
  return listed.stdout.split('\n').filter(file => inPlanScope(file) && !known.has(file) && moveHistoryPlacement(file) === null && !engineLeafPlacement(file));
}

/**
 * Name the active plan rows whose source is gone at HEAD: neither the original, its target nor its mapped path is
 * tracked or on disk. A later move would otherwise look for a file no item can ever produce (#1559 met
 * src/agent-proof-guidance.js after #1613 deleted it), so the check names the row and how to retire it.
 */
export function stalePlanRows(root, plan) {
  const listed = tryGit(root, ['ls-files', '-z']);
  if (listed.status !== 0) throw new Refused('CELLS_PLAN_GIT', 'run the plan check inside a Git checkout');
  const tracked = new Set(listed.stdout.split('\0').filter(Boolean));
  const map = readPathMap(root);
  /** A path counts as present when Git tracks it or anything, even a dangling link, sits at it. */
  function present(path) {
    if (tracked.has(path)) return true;
    try { lstatSync(join(root, path)); return true; }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
  }
  return plan.cells.flatMap(cell => cell.paths.filter(([from, to]) => ![from, to, mappedPath(map, from)].some(present))
    .map(row => ({ cell: cell.name, file: shardFile(cell), row })));
}

/**
 * Retire one stale planned path: its row moves to the plan's retired list, which keeps its provenance and refuses
 * it ever coming back or being imported, and the shim and cut edges that only existed for it leave the cell.
 */
export function retirePath(root, file) {
  const plan = readPlan(root);
  const stale = stalePlanRows(root, plan).find(entry => entry.row[0] === file);
  if (!stale) {
    const active = plan.cells.some(cell => cell.paths.some(([from]) => from === file));
    throw new Refused('CELLS_PLAN_RETIRE', active
      ? `${file} still exists at HEAD or at its target; retire only a planned path its item deleted`
      : `${file} is not an active plan row; name a path that node bin/cells-plan.js --check reports as stale`);
  }
  const cell = plan.cells.find(entry => entry.name === stale.cell);
  cell.paths = cell.paths.filter(([from]) => from !== file);
  cell.reexports = cell.reexports.filter(path => path !== file);
  for (const entry of plan.cells) {
    entry.cuts = entry.cuts.map(link => ({ ...link, edges: link.edges.filter(edge => !edge.split('->').includes(file)) }))
      .filter(link => link.edges.length).map(link => ({ ...link, imports: link.edges.length }));
  }
  plan.retired = [...(plan.retired ?? []), { cell: cell.name, row: stale.row }];
  writePlan(root, plan);
  return stale;
}

/**
 * The main commit this move builds on: its merge base with main. Null, so every unproven read still counts, when
 * there is no main or HEAD is itself that base (a check on main has no earlier state to compare against).
 */
function moveBase(root) {
  const head = tryGit(root, ['rev-parse', 'HEAD']).stdout;
  for (const ref of ['main', 'origin/main']) {
    const found = tryGit(root, ['merge-base', 'HEAD', ref]);
    if (found.status === 0 && /^[a-f0-9]{40,64}$/u.test(found.stdout)) return found.stdout === head ? null : found.stdout;
  }
  return null;
}

const historyReferencesByBase = new Map();

/** Read only sealed history already present on the accepted base; candidate edits cannot create authority. */
function historyShimReferences(root, acceptedBase) {
  const base = acceptedBase || tryGit(root, ['rev-parse', 'main']).stdout || tryGit(root, ['rev-parse', 'HEAD']).stdout;
  if (!/^[a-f0-9]{40,64}$/u.test(base)) return new Map();
  const key = `${root}\0${base}`;
  if (historyReferencesByBase.has(key)) return historyReferencesByBase.get(key);
  const listing = tryGit(root, ['ls-tree', '-r', '--name-only', base, '--', 'src/move-history']);
  if (listing.status !== 0) return new Map();
  const declarations = new Map();
  for (const file of listing.stdout.split('\n').filter(file => /^src\/move-history\/\d+\.json$/u.test(file))) {
    const blob = tryGit(root, ['show', `${base}:${file}`]);
    if (blob.status !== 0) continue;
    try {
      const row = JSON.parse(blob.stdout);
      if (row.version !== 1 || row.engine !== Number(posix.basename(file, '.json')) || !row.declarations || Array.isArray(row.declarations) || typeof row.declarations !== 'object') continue;
      for (const [name, source] of Object.entries(row.declarations)) {
        if (/^[A-Za-z0-9_-]+\.js$/u.test(name) && typeof source === 'string') declarations.set(`${name}\0${source}`, { name, source, file });
      }
    } catch { /* An invalid snapshot supplies no authority. */ }
  }
  const refs = new Map(), rows = [...declarations.values()];
  /** One broken historical declaration cannot authorize anything or hide other valid declarations. */
  function scan(batch) {
    if (!batch.length) return;
    let edges;
    try { edges = importsIn(batch.map(row => row.source)); }
    catch {
      if (batch.length > 1) { const mid = Math.floor(batch.length / 2); scan(batch.slice(0, mid)); scan(batch.slice(mid)); }
      return;
    }
    for (const [index, specifiers] of edges.entries()) for (const specifier of specifiers) if (specifier.startsWith('.')) {
      const target = posix.normalize(posix.join('src/moves', specifier));
      if (!refs.has(target)) refs.set(target, batch[index].file);
    }
  }
  for (let index = 0; index < rows.length; index += 100) scan(rows.slice(index, index + 100));
  historyReferencesByBase.set(key, refs);
  return refs;
}

/**
 * Check that one cell's move happened as planned: every path sits at its target, every old path is gone or is
 * only a re-export through the reachable front door, and no enforced cell lint rose. This is each move item's frozen check.
 */
export function checkMoved(root, plan, name, { notes = [], acceptedBase, lintReport, lintBaseline, inventory: suppliedInventory } = {}) {
  const cell = plan.cells.find(row => row.name === name);
  if (!cell) throw new Refused('CELLS_PLAN_CELL', `no cell ${name} in ${PLAN_FILE}; use a name from its cells list`);
  const problems = [];
  let workerFiles;
  let moveFiles;
  let inventory = suppliedInventory;
  let exceptions;
  let history;
  /** Build the repository inventory once and share it across move closure and lint checks. */
  const sharedInventory = () => inventory ??= cellInventory(root, { importsIn, commonJsIn });
  /** Only the canonical bounded process-entry closure can authorize an exact own-body named shim. */
  function inWorkerClosure(from, to) {
    if (workerFiles === undefined) {
      try { workerFiles = runnerWorkerFiles(root, { importsIn, commonJsIn, files: sharedInventory().files.keys() }); }
      catch { workerFiles = new Set(); /* An unprovable worker closure grants no shim exception. */ }
    }
    return workerFiles.has(from) && workerFiles.has(to);
  }
  /** Actual move descriptors can retain only their exact own-body shim, with no opaque closure. */
  function inMoveClosure(from, to) {
    if (moveFiles === undefined) {
      try { moveFiles = moveDeclarationFiles(root, { importsIn, commonJsIn,
        files: sharedInventory().files.keys() }); }
      catch { moveFiles = new Set(); /* An unprovable move closure grants no shim exception. */ }
    }
    return moveFiles.has(from) && moveFiles.has(to);
  }
  function keptReason(from, to) {
    exceptions ??= temporaryCellEdges(sharedInventory().files);
    const edge = exceptions.edges.find(row => row.importer === from && row.target === to);
    if (edge && Date.parse(`${edge.expires}T00:00:00Z`) > Date.now()
      && !exceptions.problems.some(problem => problem.includes(`${from} -> ${to}:`))) return `live temporary edge #${edge.contractItem} until ${edge.expires}`;
    history ??= historyShimReferences(root, acceptedBase);
    return history.has(from) ? `sealed move history ${history.get(from)}` : null;
  }
  problems.push(...pureFrontDoorProblems(root, cell));
  if (!existsSync(join(root, cell.frontDoor))) problems.push(`missing front door ${cell.frontDoor}`);
  const stale = new Set(stalePlanRows(root, plan).filter(entry => entry.cell === name).map(entry => entry.row[0]));
  for (const [from, to] of cell.paths) {
    if (stale.has(from)) { problems.push(`${from} was deleted, so its plan row is stale; retire it: node bin/cells-plan.js --retire ${from}`); continue; }
    if (!existsSync(join(root, to))) problems.push(`missing ${to} (from ${from})`);
    if (existsSync(join(root, from)) && /\.[cm]?js$/u.test(from)) {
      const code = readFileSync(join(root, from), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '').replace(/\s/gu, '');
      if (!/^(?:export(?:\*|\{[^}]*\})from(?:'[^']*'|"[^"]*");)+$/u.test(code)) problems.push(`${from} still holds code; leave only a re-export shim`);
      else for (const match of code.matchAll(/from(['"])([^'"]*)\1;/gu)) {
        const target = match[2].startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), match[2])) : null;
        const namedLeaf = target === to && /^(?:export\{[^}]+\}from(?:'[^']*'|"[^"]*");)+$/u.test(code);
        const reason = namedLeaf && !inWorkerClosure(from, to) && !inMoveClosure(from, to) ? keptReason(from, to) : null;
        const exactLeaf = namedLeaf && (reason || inWorkerClosure(from, to) || inMoveClosure(from, to));
        if (reason) notes.push(`${from} kept: ${reason}`);
        if (target !== cell.frontDoor && target !== cell.pureFrontDoor && !exactLeaf) problems.push(`${from} bypasses front door ${cell.frontDoor}; re-export through it, not ${match[2]}`);
      }
    } else if (existsSync(join(root, from))) problems.push(`${from} still exists; move the asset to ${to}`);
  }
  const snapshot = tryGit(root, ['rev-parse', 'HEAD']);
  // One tree listing names every tracked blob; each read used to ask Git once (#2601).
  const blobs = snapshot.status === 0 ? treeBlobs(root, snapshot.stdout) : new Map();
  /** Bind producer bytes to the current regular tracked snapshot; symlink ancestors never supply analysis authority. */
  function readSource(file) {
    if (snapshot.status !== 0 || !/^[\w./-]+$/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) return null;
    let path = root;
    for (const part of file.split('/')) { path = join(path, part); if (lstatSync(path).isSymbolicLink()) return null; }
    if (!lstatSync(path).isFile()) return null;
    const object = blobs.get(file);
    return object ? { source: readFileSync(path, 'utf8'), object } : null;
  }
  const listed = tryGit(root, ['ls-files', '-z', '--', 'test', 'docs']);
  if (listed.status !== 0) throw new Refused('CELLS_PLAN_GIT', 'cannot inventory tracked fixture readers');
  const base = acceptedBase === undefined ? moveBase(root) : acceptedBase;
  const data = readMoveDataReads(root, cell.name), matchedDataReads = [];
  problems.push(...data.problems);
  for (const file of listed.stdout.split('\0').filter(file => /\.[cm]?js$/u.test(file))) {
    const path = join(root, file);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      problems.push(`missing tracked fixture reader ${file}`); continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) { problems.push(`cannot prove fixture source through ${file}`); continue; }
    const source = readFileSync(path, 'utf8');
    if (!data.reads.some(row => row.file === file) && !cell.paths.some(([from]) => source.includes(from.split('/').at(-1)))) continue;
    const moves = cell.paths.map(([from, to]) => [from, to]);
    const uses = rememberedFixtureEdits(fixtureSourceEdits, source, { file, moves, readSource, objectOf: path => blobs.get(path) ?? null, dataReads: data.reads, mentionsOnly: true });
    matchedDataReads.push(...uses.matchedDataReads ?? []);
    const before = uses.problems.some(problem => unsupportedSite(problem, file, source))
      ? baseUnsupported(root, base, file, { moves, dataReads: data.reads }) : new Map();
    for (const problem of uses.problems) {
      const site = unsupportedSite(problem, file, source);
      const key = site && !moves.some(([from]) => site.text.includes(posix.basename(from))) ? `${site.text}\0${site.reason}` : null;
      if (key && before.get(key) > 0) { before.set(key, before.get(key) - 1); notes.push(`${problem} (also at main ${base.slice(0, 12)}; not this move's obligation)`); }
      else problems.push(problem);
    }
    for (const edit of uses.edits) {
      const line = source.slice(0, edit.start).split('\n').length;
      problems.push(`${file}:${line} still hand-copies or reads a moved source path; repoint its source operand before submitting the move`);
    }
  }
  problems.push(...staleDataReads(data.reads, matchedDataReads));
  const report = lintReport ?? cellLintReport(root, { importsIn, commonJsIn }, { inventory: sharedInventory() });
  const cellRoot = posix.dirname(cell.frontDoor);
  if (report.metrics.unreachable.findings.some(row => row.key === cell.frontDoor)
    || report.metrics.unreachablePackages.findings.some(row => row.key === cellRoot)) {
    problems.push(`unreachable front door ${cell.frontDoor}; ${cellRoot} must remain reachable from a production app through its front door`);
  }
  const main = lintBaseline ? { baseline: lintBaseline, report } : mainCellLintReport(root, { importsIn, commonJsIn }); // main counted now, never a stored file [C7]
  for (const row of main ? cellLintGrowth({ ...report, transition: main.report.transition }, main.baseline, { enforcedOnly: true }) : []) problems.push(`cell lint ${row.metric}:${row.key} rose to ${row.actual} over ${row.allowed}`);
  saveFixtureEdits();
  return problems;
}

/** The title tail that names one cell's move item, stable when a regenerated plan renumbers the moves. */
export function moveTitleTail(cell) {
  return `: ${cell.name.replace(/^app:/u, '')} moves into ${cell.root} behind shims`;
}

/**
 * Build each `pullboard add` argument list in plan order for the cells not yet on the board; ids already known
 * (from the board or earlier adds) fill --after, and a cell with no earlier dependency waits on #1395's tooling.
 */
export function itemCommands(plan, ids = new Map(), first = 1395) {
  for (const cell of plan.cells) if (cell.item.existing) ids.set(cell.name, String(cell.item.existing));
  return plan.cells.filter(cell => !ids.has(cell.name)).map(cell => {
    const after = cell.item.after.map(name => ids.get(name) ?? `<${name}>`);
    if (!after.length) after.push(String(first));
    return { cell, args: ['add', cell.item.lane, cell.item.title, '--criterion', cell.item.criterion, '--specs', cell.item.specs.join(','),
      '--check', cell.item.check, '--after', after.join(','), '--brief', `Plan entry ${cell.order} in ${shardFile(cell)} (item #1473) lists the paths, targets, cuts and ratchet counts. Shims re-export through ${cell.frontDoor}, never a moved leaf directly; keep that front door reachable from a production app.`, '--json'] };
  });
}

/** Find move items already on the board by their title tail, so a rerun files nothing twice. */
function boardMoveItems(root, plan) {
  const run = spawnSync('pullboard', ['list', 'core', '--all', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Refused('CELLS_PLAN_FILE', `pullboard list failed: ${run.stderr.trim()}; run this from a joined checkout`);
  const items = JSON.parse(run.stdout).items ?? [];
  const ids = new Map();
  for (const cell of plan.cells) {
    const found = items.find(item => item.item_title?.endsWith(moveTitleTail(cell)));
    if (found) ids.set(cell.name, String(found.item_id));
  }
  return ids;
}

/** Print, or with --yes file, each missing move item in plan order; reruns skip items already on the board. */
function fileItems(root, plan, yes) {
  const ids = boardMoveItems(root, plan);
  for (const [name, id] of ids) console.log(`${name} is already #${id}`);
  for (let next = itemCommands(plan, ids)[0]; next; next = itemCommands(plan, ids)[0]) {
    const { cell, args } = next;
    if (!yes) {
      console.log(['pullboard', ...args.map(arg => JSON.stringify(arg))].join(' '));
      ids.set(cell.name, `<${cell.name}>`);
      continue;
    }
    const run = spawnSync('pullboard', args, { cwd: root, encoding: 'utf8' });
    if (run.status !== 0) throw new Refused('CELLS_PLAN_FILE', `pullboard add for ${cell.name} failed: ${run.stderr.trim()}; fix it and rerun, which skips the items already filed`);
    const id = /"item_id"\s*:\s*(\d+)/u.exec(run.stdout)?.[1] ?? /#(\d+)/u.exec(run.stdout)?.[1];
    if (!id) throw new Refused('CELLS_PLAN_FILE', `pullboard add for ${cell.name} printed no id; check the board, then rerun`);
    ids.set(cell.name, id);
    console.log(`${cell.name} #${id}`);
  }
  if (!yes) console.log('dry run: nothing filed; add --yes to file these items');
}

/** Run one mode from the command line. */
function main(argv) {
  const [mode = '--check', ...rest] = argv;
  const root = resolve('.');
  if (mode === '--engine-stays') {
    const [cellName, ...paths] = rest;
    const next = retainEnginePaths({ root, plan: readPlan(root), cellName, paths, pathMap: readPathMap(root) });
    writePlan(root, next);
    console.log(`retained ${paths.length} canonical engine paths in src`);
    return;
  }
  if (mode === '--refresh-cuts') {
    const plan = readPlan(root), { edges, unknown } = cellInventory(root, { importsIn, commonJsIn });
    const endpoints = new Set([...edges.keys(), ...[...edges.values()].flatMap(rows => rows.map(row => row.target))]);
    const missing = unplanned(root, plan).filter(file => endpoints.has(file));
    if (missing.length) throw new Refused('CELLS_PLAN_UNPLANNED', `cannot refresh cuts for unplanned tracked sources: ${missing.join(', ')}; place them through the plan generator first`);
    writePlan(root, refreshPlanCuts(plan, edges, readPathMap(root), unknown));
    return 0;
  }
  if (mode === '--write') {
    writePlan(root, computePlan(root));
    return 0;
  }
  if (mode === '--stay') return main(['--place', rest[0], '--stay', ...rest.slice(1)]);
  if (mode === '--place') {
    const [file, ...options] = rest;
    const allowed = new Set(['--cell', '--part', '--stay', '--entry', '--owner']);
    const values = {};
    for (let i = 0; i < options.length; i++) {
      const flag = options[i];
      if (!allowed.has(flag) || Object.hasOwn(values, flag)) throw new Refused('CELLS_PLAN_MODE', 'use --place <path> --cell <cell> [--entry | --part core|shell], or --place <path> --stay [--owner <cell>]');
      values[flag] = ['--stay', '--entry'].includes(flag) ? true : options[++i];
      if (values[flag] === undefined) throw new Refused('CELLS_PLAN_MODE', `supply the value for ${flag}`);
    }
    placePath(root, file, { cell: values['--cell'], stay: values['--stay'] === true, part: values['--part'] ?? 'shell', entry: values['--entry'] === true, owner: values['--owner'] });
    return 0;
  }
  if (mode === '--check') return cachedCellsRun(root, [mode], () => {
    const plan = readPlan(root), missing = unplanned(root, plan), stale = stalePlanRows(root, plan);
    const entries = [...entryPlacementProblems(root, plan), ...ownedStayProblems(plan)];
    for (const problem of entries) console.error(problem);
    for (const path of missing) console.error(`not in ${PLAN_FILE}: ${path}`);
    if (missing.length) console.error('regenerate the plan: node bin/cells-plan.js --write');
    for (const { file, row } of stale) console.error(`stale plan row in ${file}: ${row[0]} no longer exists; retire it: node bin/cells-plan.js --retire ${row[0]}`);
    return missing.length || stale.length || entries.length ? 1 : 0;
  }, { code: [fileURLToPath(import.meta.url)] });
  if (mode === '--retire') {
    const { file, row } = retirePath(root, rest[0]);
    console.log(`retired ${row[0]} from ${file}`);
    return 0;
  }
  if (mode === '--moved') return cachedCellsRun(root, [mode, ...rest], () => {
    const notes = [], problems = checkMoved(root, readPlan(root), rest[0], { notes });
    for (const note of notes) console.log(note);
    for (const problem of problems) console.error(problem);
    return problems.length ? 1 : 0;
  }, { code: [fileURLToPath(import.meta.url)] });
  if (mode === '--remove-shims') {
    const laneAt = rest.indexOf('--lane'), lane = laneAt < 0 ? 'core' : rest[laneAt + 1];
    const outAt = rest.indexOf('--output-dir'), directory = outAt < 0 ? undefined : rest[outAt + 1];
    const fileCut = rest.includes('--file-cut');
    const cells = rest.filter((_value, index) => !(laneAt >= 0 && (index === laneAt || index === laneAt + 1))
      && !(outAt >= 0 && (index === outAt || index === outAt + 1)) && rest[index] !== '--file-cut');
    if (cells.length !== 1 || !lane || (outAt >= 0 && !directory)) throw new Refused('CELLS_PLAN_MODE', 'use --remove-shims <cell> [--lane <lane>] [--output-dir <directory>] [--file-cut]');
    const plan = readPlan(root), cell = plan.cells.find(row => row.name === cells[0]);
    // One parse cache for the whole sweep: unchanged sources are never re-compiled across repoint iterations (#2232).
    const result = recordToolCommand(root, { tool: 'remove-shims', cell: cells[0], lane }, () => withParseScope(() => {
      const removed = removeShims(root, plan, cells[0], { parsers: { importsIn, commonJsIn }, lane, planFiles: planWrites(root, plan, cells[0]) });
      if (removed.changed) writePlan(root, removed.plan);
      return removed;
    }));
    for (const line of shimReport(result)) console.log(line);
    const handoff = writeShimHandoff(root, result, cells[0], { lane, directory, fileCut });
    if (handoff) console.log(`${handoff.fact}\nCut item: ${handoff.title}\n${handoff.criterion}\nAfter: ${handoff.after ?? '<removal item id>'}\n${handoff.command}\nHandoff: ${handoff.directory}`);
    return 0;
  }
  if (mode === '--file-cuts') { fileCuts(root, readPlan(root), rest.includes('--yes')); return 0; }
  if (mode === '--cuts') return cachedCellsRun(root, [mode, ...rest], () => {
    const problems = checkCuts(root, readPlan(root), rest[0]);
    for (const problem of problems) console.error(problem);
    return problems.length ? 1 : 0;
  }, { code: [fileURLToPath(import.meta.url)] });
  if (mode === '--file') { fileItems(root, readPlan(root), rest.includes('--yes')); return 0; }
  if (mode === '--place-tests') {
    if (rest.length) throw new Refused('CELLS_PLAN_MODE', 'use node bin/cells-plan.js --place-tests (no arguments)');
    const listed = tryGit(root, ['ls-files', '-z']);
    if (listed.status !== 0) throw new Refused('CELLS_PLAN_GIT', 'cannot list tracked files for --place-tests');
    const tracked = listed.stdout.split('\0').filter(Boolean);
    console.log(placeTests(tracked, cellInventory(root, { importsIn, commonJsIn }), readPlan(root)).join('\n'));
    return 0;
  }
  if (mode === '--move-tests') {
    const [cell, ...paths] = rest;
    const listed = tryGit(root, ['ls-files', '-z']);
    if (listed.status !== 0) throw new Refused('CELLS_PLAN_GIT', 'cannot list tracked files for --move-tests');
    const tracked = listed.stdout.split('\0').filter(Boolean);
    const planned = planTestMove({ tracked, inventory: cellInventory(root, { importsIn, commonJsIn }), plan: readPlan(root), cell, paths, lex });
    if (planned.refused) throw new Refused(planned.refused.code, planned.refused.message);
    /** Run one git step of the move, refusing with git's own words when it fails. */
    const git = args => {
      const run = tryGit(root, args);
      if (run.status !== 0) throw new Refused('CELLS_PLAN_GIT', `git ${args[0]} failed during --move-tests: ${run.stderr.trim()}`);
    };
    for (const line of applyTestMove(root, planned, git)) console.log(line);
    return 0;
  }
  throw new Refused('CELLS_PLAN_MODE', 'use node bin/cells-plan.js --place <path> --cell <cell> [--entry] (or --stay [--owner <cell>]) | --stay <path> --owner <cell> | --engine-stays <cell> <path>... | --refresh-cuts | --check | --retire <path> | --moved <cell> | --file [--yes] | --file-cuts [--yes] | --place-tests | --move-tests <cell> [<path>...] | --cuts <cell> | --remove-shims <cell> [--lane <lane>]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
