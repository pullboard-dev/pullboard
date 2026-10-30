import { withBindingReadCache } from '../packages/codemap/index.js';
/** Trusted controller-only analysis of immutable submit compositions [C7,D3,CD64]. */
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../src/git.js';
import { tryGit } from '../src/git.js';
import { cleanGitEnvironment } from '../src/git.js';
import { Refused } from '../src/refused.js';
import { cellInventory } from '../packages/codemap/index.js';
import { cellLintReport } from '../packages/codemap/index.js';
import { cellLintGrowth } from '../packages/codemap/index.js';
import { readCellLintBaseline } from '../packages/codemap/index.js';
import { CELL_BASELINE_DESCRIPTOR } from '../packages/codemap/index.js';
import { readPathMap } from '../packages/codemap/index.js';
import { checkCuts } from './cells-plan-cuts.js';
import { cutTitle } from '../packages/codemap/index.js';
import { frontDoorBypasses } from './cells-plan-cuts.js';
import { checkMoved } from './cells-plan.js';
import { pureFrontDoorProblems } from './cells-pure-front-door.js';
import { readPlan } from './cells-plan.js';
import { shardFile } from './cells-plan.js';
import { unplanned } from './cells-plan.js';
import { stalePlanRows } from './cells-plan.js';

/** Exact multiset subtraction keeps duplicate diagnostics from borrowing one old allowance. */
function additions(before, after) {
  const counts = new Map();
  for (const value of before) counts.set(value, (counts.get(value) ?? 0) + 1);
  return after.filter(value => {
    if (!(counts.get(value) > 0)) return true;
    counts.set(value, counts.get(value) - 1);
    return false;
  });
}

/** Read only landed core cut candidates through the controller's already-open connection. */
export function landedCutItemRows(db) {
  return db.prepare(`SELECT item_id, item_lane, item_title, item_status, item_merged_commit FROM item
    WHERE item_lane='core' AND item_status='verified' AND item_merged_commit IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM board_meta WHERE meta_key='item_redirect:' || item_id)`).all();
}

/** Read cut authority only from the trusted controller's board snapshot and pinned accepted ancestry. */
function landedCutCells(root, acceptedMain, plan, readCutItems) {
  if (typeof readCutItems !== 'function') throw new Refused('CELLS_SUBMIT', 'trusted board cut-item reader is required');
  const items = readCutItems(acceptedMain, root);
  if (!Array.isArray(items)) throw new Refused('CELLS_SUBMIT', 'trusted board cut-item reader must return actual item rows');
  const titles = new Map(plan.cells.map(cell => [cutTitle(cell.name), cell.name]));
  const landed = new Set();
  for (const item of items) {
    const cell = titles.get(item.item_title);
    if (!cell || item.item_lane !== 'core' || item.item_status !== 'verified'
      || !/^[a-f0-9]{40,64}$/u.test(item.item_merged_commit ?? '')) continue;
    if (tryGit(root, ['merge-base', '--is-ancestor', item.item_merged_commit, acceptedMain]).status === 0) landed.add(cell);
  }
  return landed;
}

/** A malformed analysis is a refusal, never an empty set of findings. */
function refuse(problems) {
  if (problems.length) throw new Refused('CELLS_SUBMIT', problems.join('; '));
}

/** Preserve accepted ownership; candidate metadata may not hide an existing implementation in a stay or later cell. */
function policyProblems(before, after, beforeMap, afterMap, candidateRoot) {
  const problems = [], cells = new Map(after.cells.map(cell => [cell.name, cell]));
  const rows = new Map(), targets = new Set(), orders = new Set(), roots = new Set();
  const relative = value => typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
  for (const cell of after.cells) {
    if (!Number.isSafeInteger(cell.order) || cell.order < 1 || orders.has(cell.order)) problems.push(`invalid or duplicate cell order: ${cell.name}`);
    orders.add(cell.order);
    if (!relative(cell.root) || !relative(cell.frontDoor) || !cell.frontDoor.startsWith(cell.root + '/')) problems.push(`invalid cell root/front door: ${cell.name}`);
    if ([...roots].some(root => root === cell.root || root.startsWith(cell.root + '/') || cell.root.startsWith(root + '/'))) problems.push(`overlapping cell root: ${cell.root}`);
    roots.add(cell.root);
  }
  for (const cell of after.cells) for (const row of cell.paths) {
    if (!Array.isArray(row) || row.length !== 3 || !relative(row[0]) || !relative(row[1]) || !row[1].startsWith(cell.root + '/') || targets.has(row[1])) problems.push(`invalid or duplicate placement target in ${cell.name}: ${row?.[1]}`);
    targets.add(row[1]);
    if (rows.has(row[0])) problems.push(`plan repeats ${row[0]}`);
    rows.set(row[0], { cell, row });
  }
  for (const cell of before.cells) {
    const next = cells.get(cell.name);
    if (!next || ['order', 'root', 'frontDoor'].some(key => next[key] !== cell[key])
      || (cell.pureFrontDoor !== undefined && next.pureFrontDoor !== cell.pureFrontDoor)) {
      problems.push(`accepted cell ${cell.name} identity/order/front door changed`);
      continue;
    }
    if (cell.pureFrontDoor === undefined && next.pureFrontDoor !== undefined) {
      problems.push(...pureFrontDoorProblems(candidateRoot, next).map(problem => `${cell.name}: ${problem}`));
    }
    for (const row of cell.paths) {
      const current = rows.get(row[0]);
      const retired = after.retired?.some(entry => entry.cell === cell.name && JSON.stringify(entry.row) === JSON.stringify(row));
      if (!current && !retired) problems.push(`${cell.name}: accepted row ${row[0]} disappeared without exact retirement`);
      if (current && current.cell.order > cell.order) problems.push(`${cell.name}: ${row[0]} was relabeled as later ${current.cell.name}`);
    }
  }
  for (const entry of before.retired ?? []) if (!after.retired?.some(row => JSON.stringify(row) === JSON.stringify(entry))) {
    problems.push(`accepted retired provenance changed: ${entry.row[0]}`);
  }
  for (const [from, to] of afterMap) {
    if (beforeMap.get(from) === to) continue;
    const row = rows.get(from);
    if (!row || row.row[1] !== to) problems.push(`path map ${from} -> ${to} has no exact declared move row`);
  }
  for (const [from, to] of beforeMap) if (!afterMap.has(from)) problems.push(`accepted path map disappeared: ${from} -> ${to}`);
  return problems;
}

/** Metadata that supplies authority or global resolution can affect every cell. */
function sharedPolicy(file) {
  return file === 'package.json' || file === 'path-map.json' || file === 'bin/cells-plan.json'
    || file.startsWith('bin/cells-plan/') || file.startsWith('bin/cell-lint-baselines/')
    || file === 'bin/cell-lint-transition.json';
}

/** Attribute changed files and their transitive readers using the actual accepted graph and both declared roots. */
function touchedCells(files, before, after, inventories) {
  if (files.some(sharedPolicy)) return after.cells.map(cell => cell.name);
  const known = file => [before, after].some(plan => plan.cells.some(cell => file === cell.frontDoor || file.startsWith(cell.root + '/')
    || cell.paths.some(row => row[0] === file || row[1] === file)));
  const affected = new Set(files.filter(known));
  let grew = true;
  while (grew) {
    grew = false;
    for (const inventory of inventories) for (const [file, imports] of inventory.edges) {
      if (!affected.has(file) && imports.some(edge => affected.has(edge.target))) { affected.add(file); grew = true; }
    }
  }
  const names = new Set();
  for (const plan of [before, after]) for (const cell of plan.cells) {
    if ([...affected].some(file => file === cell.frontDoor || file.startsWith(cell.root + '/')
      || cell.paths.some(row => row[0] === file || row[1] === file))) names.add(cell.name);
  }
  return [...names].sort();
}

/** Temporary metadata is permission only for the exact frozen edge, never an exception to cut analysis. */
function temporaryProblems(mainRoot, candidateRoot, criterion) {
  const file = 'bin/cells-plan/temporary-edges.json';
  const read = root => existsSync(join(root, file)) ? JSON.parse(readFileSync(join(root, file), 'utf8')).edges : [];
  const before = read(mainRoot), after = read(candidateRoot);
  if (!Array.isArray(before) || !Array.isArray(after)) return [`${file}: malformed edges`];
  return after.filter(row => !before.some(old => JSON.stringify(old) === JSON.stringify(row)))
    .filter(row => !criterion.includes(`${row.importer} -> ${row.target}`))
    .map(row => `${file}: frozen criterion does not name exact edge ${row.importer} -> ${row.target}`);
}

/** Memoize only within this census using actual higher-controller runtime policy. */
export function cellsSnapshotProblems(mainRoot, candidateRoot, options) {
  if (typeof options?.withImportParseCache !== 'function' || typeof options?.cacheEligible !== 'function') throw new Refused('CELLS_SUBMIT', 'canonical census cache services are required');
  return options.withImportParseCache(() => withBindingReadCache(() => inspectCellsSnapshotProblems(mainRoot, candidateRoot, options), { eligible: options.cacheEligible }));
}

/** Read candidate plan data without allowing shard aliases or symbolic paths outside the snapshot. */
function candidatePlan(candidateRoot) {
  // Even the index's shard names are untrusted data; no metadata alias may read outside this snapshot.
  return readPlan(candidateRoot, file => {
    if (file !== 'bin/cells-plan.json' && !/^bin\/cells-plan\/\d{2,}-[a-z-]+\.json$/u.test(file)) throw new Refused('CELLS_SUBMIT', 'invalid candidate plan shard path');
    let path = candidateRoot;
    for (const part of file.split('/')) { path = join(path, part); if (lstatSync(path).isSymbolicLink()) throw new Refused('CELLS_SUBMIT', `symbolic candidate plan path: ${file}`); }
    if (!lstatSync(path).isFile()) throw new Refused('CELLS_SUBMIT', `nonregular candidate plan: ${file}`);
    const source = readFileSync(path, 'utf8');
    if (file !== 'bin/cells-plan.json') {
      const cell = JSON.parse(source);
      if (!Number.isSafeInteger(cell?.order) || cell.order < 1 || typeof cell.name !== 'string' || shardFile(cell) !== file) throw new Refused('CELLS_SUBMIT', 'noncanonical candidate plan shard identity');
    }
    return source;
  });
}

/** Analyze clean real snapshots with loaded controller code; no candidate module is imported or executed. */
function inspectCellsSnapshotProblems(mainRoot, candidateRoot, { acceptedMain, criterion = '', files, parsers } = {}) {
  if (typeof parsers?.importsIn !== 'function' || typeof parsers?.commonJsIn !== 'function') throw new Refused('CELLS_SUBMIT', 'canonical parser services are required');
  if (!existsSync(join(mainRoot, 'bin/cells-plan.json'))) return { cells: [], problems: [] };
  const before = readPlan(mainRoot);
  const after = candidatePlan(candidateRoot);
  const mainMap = readPathMap(mainRoot), candidateMap = readPathMap(candidateRoot);
  const policy = policyProblems(before, after, mainMap, candidateMap, candidateRoot);
  policy.push(...unplanned(candidateRoot, after).map(file => `unplaced ${file}`));
  policy.push(...stalePlanRows(candidateRoot, after).map(row => `${row.cell}: stale ${row.row[0]}`));
  policy.push(...temporaryProblems(mainRoot, candidateRoot, criterion));
  if (policy.length) return { cells: [], problems: policy };
  const changed = files ?? git(candidateRoot, ['diff', '--name-only', '--no-renames', '-z', acceptedMain, 'HEAD']).split('\0').filter(Boolean);
  const direct = touchedCells(changed, before, after, []);
  if (!direct.length) return { cells: [], problems: [] };
  const oldInventory = cellInventory(mainRoot, parsers), newInventory = cellInventory(candidateRoot, parsers);
  const oldReport = cellLintReport(mainRoot, parsers, { inventory: oldInventory });
  const newReport = cellLintReport(candidateRoot, parsers, { inventory: newInventory });
  // Advisory transition authority comes only from the immutable accepted snapshot.
  newReport.transition = oldReport.transition;
  const baseline = existsSync(join(mainRoot, CELL_BASELINE_DESCRIPTOR)) ? readCellLintBaseline(mainRoot) : null;
  if (!baseline) throw new Refused('CELLS_SUBMIT', 'accepted main lacks a complete cell lint baseline');
  const cells = touchedCells(changed, before, after, [oldInventory, newInventory]);
  const problems = cellLintGrowth(newReport, baseline, { enforcedOnly: true })
    .map(row => `cell lint ${row.metric}:${row.key} rose to ${row.actual} over ${row.allowed}`);
  for (const name of cells) {
    const previous = before.cells.some(cell => cell.name === name);
    const moved = [before, after].some((plan, index) => plan.cells.find(cell => cell.name === name)?.paths
      .some(([from, to]) => [mainMap, candidateMap][index].get(from) === to));
    if (!moved) continue;
    const oldMoved = previous ? checkMoved(mainRoot, before, name, { acceptedBase: acceptedMain, lintReport: oldReport, lintBaseline: baseline }) : [];
    const newMoved = checkMoved(candidateRoot, after, name, { acceptedBase: acceptedMain, lintReport: newReport, lintBaseline: baseline });
    problems.push(...additions(oldMoved, newMoved).map(problem => `${name} --moved: ${problem}`));
  }
  return { cells, problems };
}

/** Compare only the candidate's own graph delta with its actual merge base, using trusted landed authority. */
function cutDeltaProblems(baseRoot, sourceRoot, { cutBase, landedCells, parsers }) {
  if (!existsSync(join(baseRoot, 'bin/cells-plan.json'))) return { problems: [], existingCuts: [] };
  const before = readPlan(baseRoot), after = candidatePlan(sourceRoot);
  const changed = git(sourceRoot, ['diff', '--name-only', '--no-renames', '-z', cutBase, 'HEAD']).split('\0').filter(Boolean);
  const oldInventory = cellInventory(baseRoot, parsers), newInventory = cellInventory(sourceRoot, parsers);
  const cells = touchedCells(changed, before, after, [oldInventory, newInventory]);
  const problems = [], existingCuts = [];
  for (const name of cells) {
    const previous = before.cells.some(cell => cell.name === name);
    const oldCuts = previous ? checkCuts(baseRoot, before, name, { allLaterCells: true, temporaryExceptions: false, inventory: oldInventory, acceptedInventory: oldInventory }) : [];
    existingCuts.push(...oldCuts.map(problem => `${name} --cuts: ${problem}`));
    if (!landedCells.has(name) || !after.cells.some(cell => cell.name === name)) continue;
    const newCuts = checkCuts(sourceRoot, after, name, { allLaterCells: true, temporaryExceptions: false, inventory: newInventory, acceptedInventory: oldInventory });
    problems.push(...additions(oldCuts, newCuts).map(problem => `${name} --cuts: ${problem}; import a lower cell or take a port`));
    const oldDoors = previous ? frontDoorBypasses(baseRoot, before, name, { inventory: oldInventory }) : new Map();
    for (const [key, text] of frontDoorBypasses(sourceRoot, after, name, { inventory: newInventory })) {
      if (!oldDoors.has(key)) problems.push(`${name} --cuts: ${text}; import the lower cell's front door or take a port`);
    }
  }
  return { problems, existingCuts };
}

/** Immutable snapshot callbacks may not leave changed files or a moved checkout behind. */
function unchangedSnapshot(root, commit) {
  if (git(root, ['rev-parse', 'HEAD']) !== commit || git(root, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Refused('CELLS_SUBMIT', 'immutable analysis snapshot changed during inspection');
  }
}

/** Analyze the clean immutable union with pinned main without moving a ref, index or checkout. */
function cellsComposition(root, acceptedMain, commit) {
  if (tryGit(root, ['merge-base', '--is-ancestor', acceptedMain, commit]).status === 0) return commit;
  const merged = tryGit(root, ['merge-tree', '--write-tree', '--name-only', '-z', acceptedMain, commit]);
  if (merged.status !== 0) throw new Refused('CELLS_SUBMIT', 'the candidate cannot compose cleanly with pinned accepted main; merge main, resolve conflicts and submit again');
  const tree = merged.stdout.split('\0')[0].trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree)) throw new Refused('CELLS_SUBMIT', 'Git did not return an immutable composed tree');
  const env = { ...cleanGitEnvironment(), GIT_AUTHOR_NAME: 'Pullboard cells', GIT_AUTHOR_EMAIL: 'cells@pullboard.invalid',
    GIT_COMMITTER_NAME: 'Pullboard cells', GIT_COMMITTER_EMAIL: 'cells@pullboard.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  return git(root, ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', acceptedMain, '-p', commit,
    '-m', 'chore(cells): inspect immutable submit composition [C7,D3]'], { env });
}

/** Controller structural preflight: exact immutable commits, canonical finally-cleaned snapshots, no candidate execution. */
export async function requireSubmitCells(root, acceptedMain, commit, item, services) {
  if (typeof services?.withImportParseCache !== 'function' || typeof services?.cacheEligible !== 'function' || typeof services?.withMainCheckout !== 'function' || typeof services?.parsers?.importsIn !== 'function' || typeof services?.parsers?.commonJsIn !== 'function') throw new Refused('CELLS_SUBMIT', 'canonical checkout and parser services are required');
  const { withMainCheckout, parsers, withImportParseCache, cacheEligible } = services;
  const criterion = JSON.parse(item.item_frozen ?? 'null')?.criterion ?? '';
  if (typeof criterion !== 'string' || ![acceptedMain, commit].every(value => /^[a-f0-9]{40,64}$/u.test(value))) throw new Refused('CELLS_SUBMIT', 'submit needs exact immutable commits and its frozen criterion');
  const source = commit;
  commit = cellsComposition(root, acceptedMain, source);
  const cutBase = git(root, ['merge-base', acceptedMain, source]);
  const result = await withMainCheckout(root, acceptedMain, mainRoot => withMainCheckout(root, commit, async candidateRoot => {
    const landedCells = existsSync(join(mainRoot, 'bin/cells-plan.json'))
      ? landedCutCells(root, acceptedMain, readPlan(mainRoot), services.readCutItems) : new Set();
    const result = cellsSnapshotProblems(mainRoot, candidateRoot, { acceptedMain, criterion, parsers, withImportParseCache, cacheEligible });
    /** Keep comparison code trusted and raw source separate from the union used for accepted-policy checks. */
    const inspect = (baseRoot, sourceRoot) => {
      const cuts = withImportParseCache(() => cutDeltaProblems(baseRoot, sourceRoot, { cutBase, landedCells, parsers }));
      unchangedSnapshot(baseRoot, cutBase);
      unchangedSnapshot(sourceRoot, source);
      return cuts;
    };
    const cuts = cutBase === acceptedMain
      ? source === commit ? inspect(mainRoot, candidateRoot) : await withMainCheckout(root, source, sourceRoot => inspect(mainRoot, sourceRoot))
      : await withMainCheckout(root, cutBase, baseRoot => withMainCheckout(root, source, sourceRoot => inspect(baseRoot, sourceRoot)));
    if (cuts?.unavailable) throw new Refused('CELLS_SUBMIT', cuts.unavailable);
    refuse([...result.problems, ...cuts.problems]);
    unchangedSnapshot(mainRoot, acceptedMain);
    unchangedSnapshot(candidateRoot, commit);
    return { ...result, existingCuts: cuts.existingCuts, acceptedMain, cutBase, commit, source };
  }));
  if (result?.unavailable) throw new Refused('CELLS_SUBMIT', result.unavailable);
  return result;
}
