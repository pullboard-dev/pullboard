#!/usr/bin/env node
/** Write, check or file the cells move plan, or check one cell's move against it [D3,CD60,CD64]. */
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellInventory } from '../src/cell-lint-inventory.js';
import { cellLintReport } from '../src/cell-lints.js';
import { cellLintGrowth } from '../src/cell-lint-ratchet.js';
import { readCellLintBaseline } from '../src/cell-lint-store.js';
import { CELL_BASELINE_DESCRIPTOR } from '../src/cell-lint-store.js';
import { buildCellsPlan } from '../src/cells-plan.js';
import { inPlanScope } from '../src/cells-plan.js';
import { readPathMap } from '../src/path-map.js';
import { mappedPath } from '../src/path-map.js';
import { tryGit } from '../src/git.js';
import { Refused } from '../src/refused.js';
import { checkCuts } from './cells-plan-cuts.js';
import { fileCuts } from './cells-plan-cuts.js';
import { fixtureSourceEdits } from './cells-move-fixtures.js';

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

/**
 * Serialize plan data so each path, import and cut is one line: diffs stay per path and every committed shard
 * stays under the 500-line file aim the fileSize ratchet counts [CD33].
 */
export function formatJson(value, indent = '') {
  const inner = indent + ' ';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const compact = JSON.stringify(value);
    if (value.every(entry => entry === null || typeof entry !== 'object') ? compact.length <= 120 : value.every(entry => Array.isArray(entry)) && compact.length <= 120) return compact;
    const rows = value.map(entry => (entry !== null && typeof entry === 'object' && (Array.isArray(entry) || JSON.stringify(entry).length <= 160) ? JSON.stringify(entry) : formatJson(entry, inner)));
    return `[\n${rows.map(row => inner + row).join(',\n')}\n${indent}]`;
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  return `{\n${keys.map(key => `${inner}${JSON.stringify(key)}: ${formatJson(value[key], inner)}`).join(',\n')}\n${indent}}`;
}

/** Name one cell's shard file, ordered so a directory listing reads leaf-first. */
export function shardFile(cell) {
  return `${PLAN_DIR}/${String(cell.order).padStart(2, '0')}-${cell.name.replace(':', '-')}.json`;
}

/** Write the plan as an index plus one shard per cell, removing shards a regenerated plan no longer names. */
export function writePlan(root, plan) {
  // Bounded read/modify/write callers carry old summaries; the exact paths being written own these counts.
  const cells = plan.cells.map(cell => {
    if (cell.paths.some(row => !['seed', 'rule', 'imports'].includes(row[2]))) throw new Refused('CELLS_UNPLACED', `${cell.name} has a path without a known placement source; resolve that path before writing the plan`);
    return { ...cell, placedBy: Object.fromEntries(['seed', 'rule', 'imports'].map(via => [via, cell.paths.filter(row => row[2] === via).length])) };
  });
  const totals = { ...plan.totals, cells: cells.length, movedPaths: cells.reduce((sum, cell) => sum + cell.paths.length, 0), stays: plan.stays.length,
    placedBy: Object.fromEntries(['seed', 'rule', 'imports'].map(via => [via, cells.reduce((sum, cell) => sum + cell.placedBy[via], 0)])),
    shims: cells.reduce((sum, cell) => sum + cell.reexports.length, 0),
    cutImports: cells.reduce((sum, cell) => sum + cell.cuts.reduce((sum, row) => sum + row.imports, 0), 0),
    cutEdges: cells.reduce((sum, cell) => sum + cell.cuts.length, 0) };
  mkdirSync(join(root, PLAN_DIR), { recursive: true });
  const shards = cells.map(cell => [shardFile(cell), cell]);
  const keep = new Set([SEED_FILE, `${PLAN_DIR}/temporary-edges.json`, `${PLAN_DIR}/transition.json`, ...shards.map(([file]) => file)]);
  for (const name of readdirSync(join(root, PLAN_DIR))) if (name.endsWith('.json') && !keep.has(`${PLAN_DIR}/${name}`)) rmSync(join(root, PLAN_DIR, name));
  for (const [file, cell] of shards) writeFileSync(join(root, file), formatJson(cell) + '\n');
  const index = { ...plan, totals, cells: cells.map(cell => ({ order: cell.order, name: cell.name, file: shardFile(cell) })) };
  writeFileSync(join(root, PLAN_FILE), formatJson(index) + '\n');
}

/** Read the committed plan back as one object, refusing an index whose shard is missing. */
export function readPlan(root) {
  const index = JSON.parse(readFileSync(join(root, PLAN_FILE), 'utf8'));
  const cells = index.cells.map(row => {
    if (!existsSync(join(root, row.file))) throw new Refused('CELLS_PLAN_SHARD', `${row.file} is missing; regenerate with node bin/cells-plan.js --write`);
    return JSON.parse(readFileSync(join(root, row.file), 'utf8'));
  });
  return { ...index, cells };
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
export function unplanned(root, plan) {
  const map = readPathMap(root);
  const known = new Set();
  for (const cell of plan.cells) for (const [from, to] of cell.paths) { known.add(from); known.add(to); known.add(mappedPath(map, from)); }
  for (const row of plan.stays) known.add(row.path);
  const listed = tryGit(root, ['ls-files']);
  if (listed.status !== 0) throw new Refused('CELLS_PLAN_GIT', 'run the plan check inside a Git checkout');
  return listed.stdout.split('\n').filter(file => inPlanScope(file) && !known.has(file));
}

/**
 * Check that one cell's move happened as planned: every path sits at its target, every old path is gone or is
 * only a re-export, the front door exists, and no enforced cell lint rose. This is each move item's frozen check.
 */
export function checkMoved(root, plan, name) {
  const cell = plan.cells.find(row => row.name === name);
  if (!cell) throw new Refused('CELLS_PLAN_CELL', `no cell ${name} in ${PLAN_FILE}; use a name from its cells list`);
  const problems = [];
  if (!existsSync(join(root, cell.frontDoor))) problems.push(`missing front door ${cell.frontDoor}`);
  for (const [from, to] of cell.paths) {
    if (!existsSync(join(root, to))) problems.push(`missing ${to} (from ${from})`);
    if (existsSync(join(root, from)) && /\.[cm]?js$/u.test(from)) {
      const code = readFileSync(join(root, from), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '').replace(/\s/gu, '');
      if (!/^(?:export(?:\*|\{[^}]*\})from(?:'[^']*'|"[^"]*");)+$/u.test(code)) problems.push(`${from} still holds code; leave only a re-export shim`);
    } else if (existsSync(join(root, from))) problems.push(`${from} still exists; move the asset to ${to}`);
  }
  const snapshot = tryGit(root, ['rev-parse', 'HEAD']);
  /** Bind producer bytes to the current regular tracked snapshot; symlink ancestors never supply analysis authority. */
  function readSource(file) {
    if (snapshot.status !== 0 || !/^[\w./-]+$/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) return null;
    let path = root;
    for (const part of file.split('/')) { path = join(path, part); if (lstatSync(path).isSymbolicLink()) return null; }
    if (!lstatSync(path).isFile()) return null;
    const row = tryGit(root, ['ls-tree', '-z', snapshot.stdout, '--', file]);
    const object = /^100(?:644|755) blob ([a-f0-9]+)\t/u.exec(row.stdout)?.[1];
    return row.status === 0 && object ? { source: readFileSync(path, 'utf8'), object } : null;
  }
  const listed = tryGit(root, ['ls-files', '-z', '--', 'test', 'docs']);
  if (listed.status !== 0) throw new Refused('CELLS_PLAN_GIT', 'cannot inventory tracked fixture readers');
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
    if (!cell.paths.some(([from]) => source.includes(from.split('/').at(-1)))) continue;
    const uses = fixtureSourceEdits(source, { file, moves: cell.paths.map(([from, to]) => [from, to]), readSource });
    problems.push(...uses.problems);
    for (const edit of uses.edits) {
      const line = source.slice(0, edit.start).split('\n').length;
      problems.push(`${file}:${line} still hand-copies or reads a moved source path; repoint its source operand before submitting the move`);
    }
  }
  if (existsSync(join(root, CELL_BASELINE_DESCRIPTOR))) {
    for (const row of cellLintGrowth(cellLintReport(root, { importsIn, commonJsIn }), readCellLintBaseline(root), { enforcedOnly: true })) problems.push(`cell lint ${row.metric}:${row.key} rose to ${row.actual} over ${row.allowed}`);
  }
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
      '--check', cell.item.check, '--after', after.join(','), '--brief', `Plan entry ${cell.order} in ${shardFile(cell)} (item #1473) lists the paths, targets, cuts and ratchet counts.`, '--json'] };
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
  if (mode === '--write') {
    writePlan(root, computePlan(root));
    return 0;
  }
  const plan = readPlan(root);
  if (mode === '--check') {
    const missing = unplanned(root, plan);
    for (const path of missing) console.error(`not in ${PLAN_FILE}: ${path}`);
    if (missing.length) console.error('regenerate the plan: node bin/cells-plan.js --write');
    return missing.length ? 1 : 0;
  }
  if (mode === '--moved') {
    const problems = checkMoved(root, plan, rest[0]);
    for (const problem of problems) console.error(problem);
    return problems.length ? 1 : 0;
  }
  if (mode === '--file-cuts') { fileCuts(root, plan, rest.includes('--yes')); return 0; }
  if (mode === '--cuts') {
    const problems = checkCuts(root, plan, rest[0]);
    for (const problem of problems) console.error(problem);
    return problems.length ? 1 : 0;
  }
  if (mode === '--file') { fileItems(root, plan, rest.includes('--yes')); return 0; }
  throw new Refused('CELLS_PLAN_MODE', 'use node bin/cells-plan.js --write | --check | --moved <cell> | --file [--yes] | --file-cuts [--yes] | --cuts <cell>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
