import { withImportParseCache as withSubmitParseCache } from '../../../../packages/gate/index.js';
import { withCellGitObjects } from '../../../../packages/codemap/index.js';
import { cellsObjectSnapshots } from '../../../../packages/codemap/index.js';
import { withCellSourceSnapshots } from '../../../../packages/codemap/index.js';
import { shimCountProblems } from '../../../../packages/codemap/light.js';
import { shimImportProblems } from '../../../../packages/codemap/index.js';
import { withCellLintParser } from '../../../../packages/codemap/index.js';
import { cellsCacheDirectory } from '../../../../packages/codemap/index.js';
import { inventoryCache } from '../../../../packages/codemap/index.js';
import { observationCache } from '../../../../packages/codemap/index.js';
import { acceptedCellsIdentity } from '../../../../packages/gate/index.js';
import { readAcceptedCells } from '../../../../packages/gate/index.js';
import { inventoryPending } from '../../../../packages/codemap/index.js';
import { withBindingReadCache } from '../../../../packages/codemap/index.js';
/** Trusted controller-only analysis of immutable submit compositions [C7,D3,CD64]. */
import { cellExistsSync as existsSync } from '../../../../packages/codemap/index.js';
import { cellLstatSync as lstatSync } from '../../../../packages/codemap/index.js';
import { cellReadFileSync as readFileSync } from '../../../../packages/codemap/index.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReceiptKey } from '../../../../packages/git/index.js';
import { readCheckReceipt } from '../../../../packages/git/index.js';
import { writeCheckReceipt } from '../../../../packages/git/index.js';
import { receiptDigest } from '../../../../packages/git/index.js';
import { cellGit as git } from '../../../../packages/codemap/index.js';
import { cellTryGit as tryGit } from '../../../../packages/codemap/index.js';
import { cleanGitEnvironment } from '../../../../packages/git/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { cellInventory } from '../../../../packages/codemap/index.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintGrowth } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { cellReadPathMap as readPathMap } from '../../../../packages/codemap/index.js';
import { mappedPath } from '../../../../packages/codemap/index.js';
import { checkCuts } from '../../../../packages/codemap/index.js';
import { entryPlacementProblems } from '../../../../packages/codemap/index.js';
import { processEntry } from '../../../../packages/codemap/index.js';
import { cutTitle } from '../../../../packages/codemap/index.js';
import {
  frontDoorBypasses,
  onlyForwards,
  withDeclaredLoads,
} from '../../../../packages/codemap/index.js';
import { checkMoved } from '../../../../packages/codemap/index.js';
import { lightFrontDoorProblems } from '../../../../packages/codemap/index.js';
import { pureDoorProblems } from '../../../../packages/codemap/index.js';
import { pureFrontDoorProblems } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { shardFile } from '../../../../packages/codemap/index.js';
import { unplanned } from '../../../../packages/codemap/index.js';
import { stalePlanRows } from '../../../../packages/codemap/index.js';
import { engineStayTransition } from '../../../../packages/codemap/index.js';
import { scriptMentions } from '../../../../packages/codemap/index.js';
import { testFile } from '../../../../packages/codemap/index.js';
import { posix } from 'node:path';
import { cellsReorgReason } from './cells-reorg.js';
import { warning } from './cells-reorg.js';
import { fixtureFinding } from './cells-reorg.js';
import { fixtureWarning } from './cells-reorg.js';
import { importLine } from './cells-reorg.js';

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

/** Compare exact diagnostic endpoints in the candidate's committed rename namespace, retaining all other text. */
function mappedCutDiagnostic(map, problem) {
  const edge = /^((?:[\w:-]+ still imports later [\w:-]+|production imports testkit|live import of absent retired historical path): )([^:\r\n]+) -> ([^:\r\n]+)$/u.exec(problem);
  if (edge) return `${edge[1]}${mappedPath(map, edge[2])} -> ${mappedPath(map, edge[3])}`;
  const unknown = /^(cannot prove cut through )([^:\r\n]+)(: [\s\S]*)$/u.exec(problem);
  return unknown ? `${unknown[1]}${mappedPath(map, unknown[2])}${unknown[3]}` : problem;
}

/** Normalize both exact front-door key endpoints; never match a basename or rewrite a path substring. */
function mappedBypassKey(map, key) {
  const [from, to, extra] = key.split('->');
  return to !== undefined && extra === undefined ? `${mappedPath(map, from)}->${mappedPath(map, to)}` : key;
}

/** Read only landed core cut items (titles cutTitle names), so the runner request carries a few rows, not the board [C7]. */
export function landedCutItemRows(db) {
  return db.prepare(`SELECT item_id, item_lane, item_title, item_status, item_merged_commit FROM item
    WHERE item_lane='core' AND item_status='verified' AND item_merged_commit IS NOT NULL AND item_title LIKE 'Cells import cuts: % removes imports into later cells'
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

/**
 * An accepted row may leave its cell as a plan stay only when the item's frozen criterion, written by the coordinator,
 * names it exactly as `plan stay <path>`, the file still sits at its old path and nothing occupies its old target.
 * The candidate's own stays list never authorizes itself (#2446).
 */
function approvedStay(after, row, candidateRoot, criterion) {
  const [from, to] = row;
  // The path ends at whitespace, the text end, or one of , ; . before them: apps/relay/src/io/deploy/x.js.map, x.js+copy and x.jsé never approve apps/relay/src/io/deploy/x.js.
  const named = new RegExp(`(?:^|[^\\w./-])plan stay ${from.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=$|\\s|[.,;](?:\\s|$))`, 'u');
  if (!named.test(criterion) || !(after.stays ?? []).some(stay => stay.path === from)) return false;
  try { if (!lstatSync(join(candidateRoot, from)).isFile()) return false; } catch { return false; }
  return !existsSync(join(candidateRoot, to));
}

/**
 * An accepted process entry may leave the plan's entries only when the item's frozen criterion, written by the coordinator,
 * names it exactly as `plan retire entry <path>` and its file is absent (ENOENT) or readable and no longer runs as a process (#3519).
 * The candidate's own plan never authorizes itself; a file that still runs as a process keeps its ownership.
 */
function approvedEntryRetirement(entry, candidateRoot, criterion, map) {
  const named = new RegExp(`(?:^|[^\\w./-])plan retire entry ${entry.path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=$|\\s|[.,;](?:\\s|$))`, 'u');
  if (!named.test(criterion)) return false;
  const file = join(candidateRoot, mappedPath(map, entry.path));
  // Only a path that is genuinely absent (ENOENT) or readable source that no longer runs as a process retires; any other failure refuses.
  try {
    if (!lstatSync(file).isFile()) return false;
    return !processEntry(entry.path, readFileSync(file, 'utf8'));
  } catch (error) { return error?.code === 'ENOENT'; }
}

/** Preserve accepted ownership; candidate metadata may not hide an existing implementation in a stay or later cell. */
export function policyProblems(before, after, beforeMap, afterMap, candidateRoot, mainRoot, criterion = '') {
  const problems = [], cells = new Map(after.cells.map(cell => [cell.name, cell]));
  const engineStays = engineStayTransition({ beforeRoot: mainRoot, afterRoot: candidateRoot, before, after, afterMap });
  problems.push(...engineStays.problems);
  const entryProblems = entryPlacementProblems(candidateRoot, after);
  problems.push(...entryProblems);
  const afterEntries = Array.isArray(after.entries) ? after.entries : [];
  const entries = new Set(entryProblems.length ? [] : afterEntries.map(row => row.path));
  for (const entry of before.entries ?? []) {
    if (!afterEntries.some(row => row.path === entry.path && row.cell === entry.cell) && !(!afterEntries.some(row => row.path === entry.path) && approvedEntryRetirement(entry, candidateRoot, criterion, afterMap))) problems.push(`accepted process entry ownership changed: ${entry.path}`);
  }
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
      || (cell.pureFrontDoor !== undefined && next.pureFrontDoor !== cell.pureFrontDoor && next.lightFrontDoor !== cell.pureFrontDoor)
      || (cell.lightFrontDoor !== undefined && next.lightFrontDoor !== cell.lightFrontDoor)
      || (cell.pureDoor !== undefined && next.pureDoor !== cell.pureDoor)) {
      problems.push(`accepted cell ${cell.name} identity/order/front door changed`);
      continue;
    }
    if (cell.pureFrontDoor === undefined && next.pureFrontDoor !== undefined) {
      problems.push(...pureFrontDoorProblems(candidateRoot, next).map(problem => `${cell.name}: ${problem}`));
    }
    if (cell.lightFrontDoor === undefined && next.lightFrontDoor !== undefined) {
      problems.push(...lightFrontDoorProblems(candidateRoot, next).map(problem => `${cell.name}: ${problem}`));
    }
    if (cell.pureDoor === undefined && next.pureDoor !== undefined) {
      problems.push(...pureDoorProblems(candidateRoot, next).map(problem => `${cell.name}: ${problem}`));
    }
    for (const row of cell.paths) {
      const current = rows.get(row[0]);
      const retired = after.retired?.some(entry => entry.cell === cell.name && JSON.stringify(entry.row) === JSON.stringify(row));
      if (!current && !retired && !engineStays.rows.has(row[0]) && !approvedStay(after, row, candidateRoot, criterion)) problems.push(`${cell.name}: accepted row ${row[0]} disappeared without exact retirement`);
      if (current && current.cell.order > cell.order && !entries.has(row[0])) problems.push(`${cell.name}: ${row[0]} was relabeled as later ${current.cell.name}`);
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
  return file === 'package.json' || file === 'path-map.json' || file === 'packages/codemap/data/plan/cells.json'
    || file.startsWith('packages/codemap/data/plan/') || file.startsWith('packages/codemap/data/baselines/lints/');
}

/** The plan's own settings, without its per-cell rows, so a row edit is told apart from a global one. */
function planSettings(plan) {
  const { cells, files, tests, ...settings } = plan ?? {};
  return JSON.stringify(settings);
}

/**
 * Split the changed policy files into the cells they name and a reason to recheck everything.
 * A cell's own plan shard, path-map shard or baseline shard, and an index edit that only adds, removes or edits
 * cell rows, name just those cells; any other shared file, or an index edit that names no row, still means all
 * cells, so an unknown policy file always fails safe.
 *
 * Why: 12 of the 21 slow cells steps on 8 Nov rechecked every cell for a one-row policy edit.
 *
 * @returns {{ all: string|undefined, cells: Set<string> }}
 */
function policyScope(files, plans) {
  const [before, after] = plans, cells = new Set(), names = new Map((after?.cells ?? []).map(cell => [cell.name, cell]));
  const rows = plan => new Map((plan?.cells ?? []).map(cell => [cell.name, JSON.stringify(cell)]));
  const oldRows = rows(before), newRows = rows(after);
  const changedRows = [...newRows].filter(([name, row]) => oldRows.get(name) !== row).map(([name]) => name);
  const settingsSame = planSettings(before) === planSettings(after);
  for (const file of files) {
    if (plans.some(plan => plan.stays?.some(row => row.path === file))) return { all: file, cells };
    if (!sharedPolicy(file)) continue;
    if (file === 'packages/codemap/data/plan/cells.json' && settingsSame && changedRows.length) { for (const name of changedRows) cells.add(name); continue; }
    const keyed = /^(?:packages\/codemap\/data\/plan\/path-map|packages\/codemap\/data\/baselines\/lints\/cells)\/([a-z][a-z0-9-]*)\.json$/u.exec(file)?.[1];
    const own = [...names.values()].find(cell => shardFile(cell) === file || keyed !== undefined && cell.name.replace(':', '-') === keyed);
    if (own) { cells.add(own.name); continue; }
    return { all: file, cells };
  }
  return { all: undefined, cells };
}

function allCellsReason(files, plans) {
  return policyScope(files, plans).all;
}

/** Attribute changed cells and their direct importers against both immutable graphs. */
export function touchedCells(files, before, after, inventories) {
  const plans = [before, after];
  // Shared metadata or an unowned root-tool stay can alter every reachable cell.
  const scope = policyScope(files, plans);
  if (scope.all) {
    return after.cells.map(cell => cell.name);
  }
  const byPath = new Map();
  /** A source alias and a moved target both belong to their declared cell. */
  const owners = file => {
    if (!byPath.has(file)) byPath.set(file, plans.flatMap(plan => plan.cells.filter(cell => file === cell.frontDoor
      || file === cell.pureFrontDoor || file === cell.lightFrontDoor || file === cell.pureDoor || file.startsWith(cell.root + '/')
      || cell.paths.some(row => row[0] === file || row[1] === file)).map(cell => cell.name)));
    return byPath.get(file);
  };
  const touched = new Set([...files.flatMap(owners), ...scope.cells]);
  const selected = new Set(touched);
  // A cut follows pure re-export shims across cell boundaries. Treat the effective
  // importer through those shims as direct; never traverse a real implementation.
  for (const [index, inventory] of inventories.entries()) {
    const reverse = new Map();
    const expanded = inventory.files && inventory.unknown
      ? withDeclaredLoads(inventory.files, inventory.edges, inventory.unknown, index ? inventories[0] : undefined)
      : { edges: inventory.edges, computed: inventory.computed };
    for (const [file, imports] of expanded.edges) for (const edge of imports) {
      if (!reverse.has(edge.target)) reverse.set(edge.target, []);
      reverse.get(edge.target).push(file);
    }
    const pending = [...reverse.keys()].filter(file => owners(file).some(name => touched.has(name)));
    const seen = new Set(pending);
    while (pending.length) for (const file of reverse.get(pending.pop()) ?? []) {
      for (const name of owners(file)) selected.add(name);
      const forwards = onlyForwards(inventory.files?.get(file)?.toString('utf8') ?? '', expanded.computed?.has(file) ?? false);
      if ((forwards || !owners(file).length) && !seen.has(file)) { seen.add(file); pending.push(file); }
    }
  }
  return [...selected].sort();
}

/** Temporary metadata is permission only for the exact frozen edge, never an exception to cut analysis. */
function temporaryProblems(mainRoot, candidateRoot, criterion) {
  const file = 'packages/codemap/data/plan/temporary-edges.json';
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
  return options.withImportParseCache(() => withBindingReadCache(() => inspectCellsSnapshotProblems(mainRoot, candidateRoot, options), { eligible: options.cacheEligible, observations: options.observations, warmAll: options.warmAll, onProbe: options.onBindingProbe, runtimeIdentity: options.runtimeIdentity }));
}

/** Read candidate plan data without allowing shard aliases or symbolic paths outside the snapshot. */
function candidatePlan(candidateRoot) {
  // Even the index's shard names are untrusted data; no metadata alias may read outside this snapshot.
  return readPlan(candidateRoot, file => {
    if (file !== 'packages/codemap/data/plan/cells.json' && !/^packages\/codemap\/data\/plan\/\d{2,}-[a-z-]+\.json$/u.test(file)) throw new Refused('CELLS_SUBMIT', 'invalid candidate plan shard path');
    let path = candidateRoot;
    for (const part of file.split('/')) { path = join(path, part); if (lstatSync(path).isSymbolicLink()) throw new Refused('CELLS_SUBMIT', `symbolic candidate plan path: ${file}`); }
    if (!lstatSync(path).isFile()) throw new Refused('CELLS_SUBMIT', `nonregular candidate plan: ${file}`);
    const source = readFileSync(path, 'utf8');
    if (file !== 'packages/codemap/data/plan/cells.json') {
      const cell = JSON.parse(source);
      if (!Number.isSafeInteger(cell?.order) || cell.order < 1 || typeof cell.name !== 'string' || shardFile(cell) !== file) throw new Refused('CELLS_SUBMIT', 'noncanonical candidate plan shard identity');
    }
    return source;
  });
}

/**
 * A deleted module that a test still names inside a string, such as a generated child script's import: import checks
 * cannot see it, so the deletion would turn main red the first time that test runs.
 */
function deletedScriptMentions(mainRoot, candidateRoot, changed) {
  const deleted = changed.filter(file => /\.[cm]?js$/u.test(file) && existsSync(join(mainRoot, file)) && !existsSync(join(candidateRoot, file)));
  if (!deleted.length) return [];
  const tests = git(candidateRoot, ['ls-files', '-z']).split('\0').filter(file => file && testFile(file) && /\.[cm]?js$/u.test(file));
  const files = new Map(tests.filter(file => lstatSync(join(candidateRoot, file)).isFile()).map(file => [file, readFileSync(join(candidateRoot, file))]));
  const resolve = (file, text) => text.startsWith('.') ? posix.join(posix.dirname(file), text) : null;
  return scriptMentions(files, deleted, resolve);
}

/** Read snapshot source without following a candidate-controlled directory or module symlink. */
function shimSnapshotFile(root, file) {
  if (typeof file !== 'string' || /[\\\x00-\x1f]/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  let path = root;
  for (const part of file.split('/')) {
    path = join(path, part);
    try { if (lstatSync(path).isSymbolicLink()) return undefined; }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error; }
  }
  return lstatSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;
}

/** Analyze clean real snapshots with loaded controller code; no candidate module is imported or executed. */
function inspectCellsSnapshotProblems(mainRoot, candidateRoot, { acceptedMain, criterion = '', title = '', files, parsers, inventories, collectMachinery = false, onAllCells = () => {} } = {}) {
  if (typeof parsers?.importsIn !== 'function' || typeof parsers?.commonJsIn !== 'function') throw new Refused('CELLS_SUBMIT', 'canonical parser services are required');
  if (!existsSync(join(mainRoot, 'packages/codemap/data/plan/cells.json'))) return { cells: [], problems: [], warnings: [], reorg: null };
  const before = readPlan(mainRoot);
  const after = candidatePlan(candidateRoot);
  const mainMap = readPathMap(mainRoot), candidateMap = readPathMap(candidateRoot);
  const changed = files ?? git(candidateRoot, ['diff', '--name-only', '--no-renames', '-z', acceptedMain, 'HEAD']).split('\0').filter(Boolean);
  const added = changed.filter(file => !existsSync(join(mainRoot, file)));
  const deleted = changed.filter(file => existsSync(join(mainRoot, file)) && !existsSync(join(candidateRoot, file)));
  const reorg = cellsReorgReason({ title, criterion, changed, added, deleted, before, after, beforeMap: mainMap, afterMap: candidateMap,
    readData: file => ({ before: shimSnapshotFile(mainRoot, file), after: shimSnapshotFile(candidateRoot, file) }) });
  const warnings = [];
  const policy = policyProblems(before, after, mainMap, candidateMap, candidateRoot, mainRoot, criterion);
  const oldInventory = inventories ? inventories.base(mainRoot, acceptedMain) : cellInventory(mainRoot, parsers);
  const newInventory = inventories ? inventories.candidate(candidateRoot, oldInventory, changed) : cellInventory(candidateRoot, parsers);
  const unplaced = unplanned(candidateRoot, after, newInventory);
  const machinery = [];
  if (reorg && unplaced.length) {
    const message = `source paths have no cells-plan entry: ${unplaced.join(', ')}; place each with node packages/codemap/src/io/cells/scripts/plan.js --place <path> --cell <cell> (or --stay), then commit the source and plan`;
    if (!collectMachinery) throw new Refused('CELLS_PLAN_UNPLACED', message);
    machinery.push({ kind: 'placement', code: 'CELLS_PLAN_UNPLACED', message, rule: receiptDigest(readFileSync(fileURLToPath(import.meta.url), 'utf8')) });
  }
  warnings.push(...unplaced.map(file => warning(file, 1, 'no cells-plan placement', `node packages/codemap/src/io/cells/scripts/plan.js --place ${file} --cell <cell> (or --stay), then commit the plan`)));
  policy.push(...stalePlanRows(candidateRoot, after).map(row => `${row.cell}: stale ${row.row[0]}`));
  policy.push(...temporaryProblems(mainRoot, candidateRoot, criterion));
  for (const row of deletedScriptMentions(mainRoot, candidateRoot, changed)) {
    if (reorg) policy.push(`${row.file}:${row.line} names deleted ${row.path} inside a string; point it at the moved file or front door`);
    else warnings.push(warning(row.file, row.line, `names deleted ${row.path} inside a string`, 'point it at the moved file or front door'));
  }
  policy.push(...shimImportProblems({ plans: [before, after], parseImports: parsers.importsIn, criterion,
    read: (revision, file) => shimSnapshotFile(revision === 'before' ? mainRoot : candidateRoot, file),
    changes: changed.map(file => ({ file, before: shimSnapshotFile(mainRoot, file), after: shimSnapshotFile(candidateRoot, file) })) }));
  if (policy.length && !collectMachinery) return { cells: [], problems: policy, warnings, reorg };
  const fallback = allCellsReason(changed, [before, after]);
  if (fallback) onAllCells(fallback);
  const direct = touchedCells(changed, before, after, []);
  if (!direct.length) return { cells: [], problems: policy, warnings, reorg, ...(collectMachinery ? { machinery } : {}) };
  const oldReport = inventories?.report?.(mainRoot, acceptedMain) ?? cellLintReport(mainRoot, parsers, { inventory: oldInventory });
  const newReport = cellLintReport(candidateRoot, parsers, { inventory: newInventory });
  // Advisory transition authority comes only from the immutable accepted snapshot.
  newReport.transition = oldReport.transition;
  // The ratchet compares with main's own debt computed now; a committed snapshot that drifted never refuses an item [C7].
  const baseline = cellLintBaseline(oldReport);
  const cells = touchedCells(changed, before, after, [oldInventory, newInventory]);
  const problems = [...policy, ...cellLintGrowth(newReport, baseline, { enforcedOnly: true })
    .map(row => `cell lint ${row.metric}:${row.key} rose to ${row.actual} over ${row.allowed}`)];
  problems.push(...shimCountProblems({ before: oldReport, after: newReport, beforeInventory: oldInventory, afterInventory: newInventory }));
  for (const name of cells) {
    const previous = before.cells.some(cell => cell.name === name);
    const moved = [before, after].some((plan, index) => plan.cells.find(cell => cell.name === name)?.paths
      .some(([from, to]) => [mainMap, candidateMap][index].get(from) === to));
    if (!moved) continue;
    const oldMoved = previous ? checkMoved(mainRoot, before, name, { acceptedBase: acceptedMain, lintReport: oldReport, lintBaseline: baseline, inventory: oldInventory }) : [];
    const newMoved = checkMoved(candidateRoot, after, name, { acceptedBase: acceptedMain, lintReport: newReport, lintBaseline: baseline, inventory: newInventory });
    for (const problem of additions(oldMoved, newMoved)) {
      if (!reorg && fixtureFinding(problem)) warnings.push(fixtureWarning(name, problem));
      else problems.push(`${name} --moved: ${problem}`);
    }
  }
  return { cells, problems, warnings, reorg, allCellsReason: fallback ?? null, ...(collectMachinery ? { machinery } : {}) };
}

/**
 * Run one side's cut check, turning a plan the cut tooling cannot read into a CELLS_SUBMIT refusal that names the side
 * and the error. Why: on 9 Nov #3689 renumbered the cell order and importCuts threw "cut links must name an earlier
 * importing cell"; the uncaught throw killed the remote analysis and every section came back RUNNER_RESULT_INVALID, a
 * machine fault, when the candidate's own plan was the problem.
 *
 * @template T
 * @param {'candidate' | 'accepted main'} side
 * @param {string} cell
 * @param {() => T} check
 * @returns {T}
 */
export function readableCuts(side, cell, check) {
  try { return check(); }
  catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused('CELLS_SUBMIT', `the ${side} cells plan cannot be cut-checked for ${cell}: ${error?.message ?? error}; ${side === 'candidate'
      ? 'make every cut link in packages/codemap/data/plan name an importing cell ordered before its target (renumber the cuts with the cells), then commit the plan'
      : 'accepted main\'s cells plan is inconsistent; tell the coordinator, who repairs main\'s plan'}`);
  }
}

/** Compare only the candidate's own graph delta with its actual merge base, using trusted landed authority. */
function cutDeltaProblems(baseRoot, sourceRoot, { cutBase, landedCells, parsers, inventories, observations, cacheEligible, onCellObservation = () => {}, collectBacklog = false }) {
  if (!existsSync(join(baseRoot, 'packages/codemap/data/plan/cells.json'))) return { problems: [], existingCuts: [], later: [] };
  const before = readPlan(baseRoot), after = candidatePlan(sourceRoot);
  const changed = git(sourceRoot, ['diff', '--name-only', '--no-renames', '-z', cutBase, 'HEAD']).split('\0').filter(Boolean);
  const oldInventory = inventories ? inventories.base(baseRoot, cutBase) : cellInventory(baseRoot, parsers);
  const newInventory = inventories ? inventories.candidate(sourceRoot, oldInventory, changed) : cellInventory(sourceRoot, parsers);
  const cells = touchedCells(changed, before, after, [oldInventory, newInventory]);
  const problems = [], existingCuts = [], later = [];
  const candidateMap = readPathMap(sourceRoot);
  for (const name of cells) {
    if (!collectBacklog && !landedCells.has(name)) continue;
    const previous = before.cells.some(cell => cell.name === name);
    const cacheKey = `cell-base-cuts:${cutBase}:${name}`;
    const cached = previous && cacheEligible?.() ? observations?.get(cacheKey)?.value : null;
    let oldCuts;
    if (Array.isArray(cached) && cached.every(value => typeof value === 'string')) {
      oldCuts = [...cached];
      onCellObservation('base-reused', name);
    } else {
      oldCuts = previous ? readableCuts('accepted main', name, () => checkCuts(baseRoot, before, name, { allLaterCells: true, temporaryExceptions: false, inventory: oldInventory, acceptedInventory: oldInventory })) : [];
      if (previous && cacheEligible?.() && observations instanceof Map && observations.size < 32768) {
        const bytes = Buffer.byteLength(cacheKey) + Buffer.byteLength(JSON.stringify(oldCuts));
        if (bytes <= 1024 * 1024) observations.set(cacheKey, { value: [...oldCuts], bytes });
      }
      onCellObservation('base-checked', name);
    }
    // The full accepted cut backlog belongs to the main audit, not every submit.
    if (collectBacklog) existingCuts.push(...oldCuts.map(problem => `${name} --cuts: ${problem}`));
    if (!landedCells.has(name) || !after.cells.some(cell => cell.name === name)) continue;
    const newCuts = readableCuts('candidate', name, () => checkCuts(sourceRoot, after, name, { allLaterCells: true, temporaryExceptions: false, inventory: newInventory, acceptedInventory: oldInventory }));
    for (const problem of additions(oldCuts.map(problem => mappedCutDiagnostic(candidateMap, problem)),
      newCuts.map(problem => mappedCutDiagnostic(candidateMap, problem)))) {
      const edge = / still imports later [\w:-]+: ([^:\r\n]+) -> ([^:\r\n]+)$/u.exec(problem);
      if (edge) later.push({ text: `${name} --cuts: ${problem}; import a lower cell or take a port`,
        warning: warning(edge[1], importLine(sourceRoot, edge[1], edge[2]), `${name} --cuts: ${problem}`, 'import a lower cell or take a port') });
      else problems.push(`${name} --cuts: ${problem}; import a lower cell or take a port`);
    }
    const oldDoors = previous ? readableCuts('accepted main', name, () => frontDoorBypasses(baseRoot, before, name, { inventory: oldInventory, acceptedInventory: oldInventory })) : new Map();
    const oldDoorKeys = new Set([...oldDoors.keys()].map(key => mappedBypassKey(candidateMap, key)));
    for (const [key, text] of readableCuts('candidate', name, () => frontDoorBypasses(sourceRoot, after, name, { inventory: newInventory, acceptedInventory: oldInventory }))) {
      if (!oldDoorKeys.has(mappedBypassKey(candidateMap, key))) problems.push(`${name} --cuts: ${text}; import the lower cell's front door or take a port`);
    }
  }
  return { problems, existingCuts, later };
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

/** Bind every approved Node preload to its actual bytes; uncertainty disables persistent reuse. */
function preloadFingerprint() {
  try {
    return String(process.env.NODE_OPTIONS ?? '').split(/\s+/u).filter(Boolean).map(token => {
      const match = /^--(?:import|require)=(.+)$/u.exec(token);
      if (!match) throw new Error('unrecognized preload');
      const value = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
      const file = value.startsWith('file:') ? fileURLToPath(value) : value;
      return { token, digest: receiptDigest(readFileSync(file).toString('base64')) };
    });
  } catch { return null; }
}

/** Inspect immutable Git source without creating working trees or writing outside the machine cache. */
export function requireSubmitCells(root, acceptedMain, commit, item, services) {
  return withCellGitObjects(root, () => inspectSubmitCells(root, acceptedMain, commit, item, services));
}

/** Compare pinned source using trusted parser ports and completed accepted-tree evidence only. */
async function inspectSubmitCells(root, acceptedMain, commit, item, services) {
  if (typeof services?.withImportParseCache !== 'function' || typeof services?.cacheEligible !== 'function' || typeof services?.parsers?.importsIn !== 'function' || typeof services?.parsers?.commonJsIn !== 'function') throw new Refused('CELLS_SUBMIT', 'canonical parser and cache services are required');
  const { parsers, withImportParseCache, cacheEligible } = services;
  const criterion = JSON.parse(item.item_frozen ?? 'null')?.criterion ?? '';
  const title = typeof item.item_title === 'string' ? item.item_title : '';
  if (typeof criterion !== 'string' || ![acceptedMain, commit].every(value => /^[a-f0-9]{40,64}$/u.test(value))) throw new Refused('CELLS_SUBMIT', 'submit needs exact immutable commits and its frozen criterion');
  const source = commit;
  // Generic repositories have no cells contract to analyze; determine that from accepted Git metadata before
  // consulting or provisioning any inventory. Planned repositories still require their completed artifact below.
  if (!git(root, ['ls-tree', '--name-only', acceptedMain, '--', 'packages/codemap/data/plan/cells.json']).trim()) {
    return { acceptedMain, source, cells: [], existingCuts: [], problems: [], warnings: [], reorg: null,
      ...(services.collectMachinery ? { machinery: [] } : {}) };
  }
  const cutRows = services.readCutItems?.(acceptedMain, root);
  if (!Array.isArray(cutRows)) throw new Refused('CELLS_SUBMIT', 'trusted board cut-item reader must return actual item rows');
  // A diff confined to root test/ and docs/ touches no cell code, so the inventory rebuild (about half of each gate on
  // 3 Nov) proves nothing; the landing's cells-plan check still covers placement of any new file.
  const changed = git(root, ['diff', '--name-only', `${acceptedMain}...${source}`]).split('\n').filter(Boolean);
  if (changed.length && changed.every(path => /^(test|docs)\//u.test(path))) {
    return { cells: [], problems: [], warnings: [], reorg: null, existingCuts: [], acceptedMain, cutBase: null, commit: source, source,
      skipped: 'no cell files changed', reused: false, ...(services.collectMachinery ? { machinery: [] } : {}) };
  }
  const preloads = cacheEligible() ? preloadFingerprint() : null;
  const inputs = { acceptedMain, source, criterion, title, cuts: cutRows, preloads, ...(services.collectMachinery ? { collectMachinery: true } : {}) };
  const samePreloads = () => preloads !== null && cacheEligible() && receiptDigest(preloadFingerprint()) === receiptDigest(preloads);
  const canReuse = preloads !== null && samePreloads() && tryGit(root, ['rev-parse', 'HEAD']).stdout?.trim() === source;
  const receiptKey = canReuse ? checkReceiptKey(root, { kind: 'cells-submit', definition: 'immutable submit cell checks',
    config: inputs, code: [import.meta.url, './commands/submit.js', '../../../../packages/codemap/src/io/module/imports.js',
      '../../../../packages/gate/src/io/imports.js', '../../../../packages/gate/src/io/test/isolation.js', '../../../../packages/landing/src/io/main/red.js']
      .map(path => fileURLToPath(new URL(path, import.meta.url))), commands: [] }) : null;
  const cached = readCheckReceipt(root, receiptKey);
  if (cached && Array.isArray(cached.result?.cells) && Array.isArray(cached.result?.existingCuts)
    && samePreloads() && receiptDigest(services.readCutItems?.(acceptedMain, root)) === receiptDigest(cutRows)) return { ...cached.result, receipt: cached, reused: true };
  const artifact = services.acceptedArtifact ?? readAcceptedCells(root, acceptedMain);
  if (!artifact?.available) throw inventoryPending(artifact?.message ? `${artifact.cause}: ${artifact.message}` : artifact?.cause ?? 'missing accepted tree artifact', acceptedMain);
  // The accepted inventory's identity is the pinned main's own tooling, whatever tooling runs this check (#3322).
  const expectedInventory = acceptedCellsIdentity(root, acceptedMain, { pinned: true });
  if (['tree', 'checker', 'preloads'].some(name => artifact.descriptor?.[name] !== expectedInventory[name])) throw inventoryPending('accepted inventory identity differs from the actual main checker', acceptedMain);
  const inventories = inventoryCache(root, receiptKey, parsers, services.onInventory, samePreloads,
    { acceptedMain, artifact, artifacts: services.acceptedArtifacts, readAccepted: readAcceptedCells, strict: true });
  const observations = observationCache(root, receiptKey, samePreloads);
  for (const [id, row] of artifact.observations ?? []) if (!observations.values.has(id)) observations.values.set(id, row);
  commit = cellsComposition(root, acceptedMain, source);
  const cutBase = git(root, ['merge-base', acceptedMain, source]);
  const snapshots = cellsObjectSnapshots(root, acceptedMain, [commit, cutBase, source], artifact, services.onSnapshotRead);
  const result = await withCellSourceSnapshots([...snapshots.values()], async () => {
    const mainRoot = snapshots.get(acceptedMain).root, candidateRoot = snapshots.get(commit).root;
    const landedCells = existsSync(join(mainRoot, 'packages/codemap/data/plan/cells.json'))
      ? landedCutCells(root, acceptedMain, readPlan(mainRoot), () => cutRows) : new Set();
    const result = withSubmitCellParser(() => cellsSnapshotProblems(mainRoot, candidateRoot, { acceptedMain, criterion, title, parsers, withImportParseCache, cacheEligible: samePreloads, inventories, observations: observations.values, warmAll: false, collectMachinery: services.collectMachinery === true, onBindingProbe: services.onBindingProbe, onAllCells: services.onAllCells, runtimeIdentity: artifact.runtimeIdentity }));
    /** Keep comparison code trusted and raw source separate from the union used for accepted-policy checks. */
    const inspect = (baseRoot, sourceRoot) => {
      const cuts = withSubmitCellParser(() => withImportParseCache(() => cutDeltaProblems(baseRoot, sourceRoot, { cutBase, landedCells, parsers, inventories, observations: observations.values, cacheEligible: samePreloads, onCellObservation: services.onCellObservation })));
      unchangedSnapshot(baseRoot, cutBase);
      unchangedSnapshot(sourceRoot, source);
      return cuts;
    };
    const cuts = inspect(snapshots.get(cutBase).root, snapshots.get(source).root);
    unchangedSnapshot(mainRoot, acceptedMain);
    unchangedSnapshot(candidateRoot, commit);
    observations.commit();
    if (cuts?.unavailable) throw new Refused('CELLS_SUBMIT', cuts.unavailable);
    // Later-cell imports refuse only Cells reorg work; every other item proceeds with them as warnings (#2473).
    const problems = [...result.problems, ...cuts.problems, ...result.reorg ? cuts.later.map(row => row.text) : []];
    const machinery = [...result.machinery ?? []];
    if (services.collectMachinery && problems.length) machinery.push({ kind: 'plan', code: 'CELLS_SUBMIT', message: problems.join('; '), rule: receiptDigest(readFileSync(fileURLToPath(import.meta.url), 'utf8')) });
    else refuse(problems);
    const warnings = [...result.warnings, ...result.reorg ? [] : cuts.later.map(row => row.warning)];
    const policy = services.collectMachinery && existsSync(join(mainRoot, 'packages/codemap/data/plan/cells.json')) ? readPlan(mainRoot) : null;
    return { ...result, warnings, existingCuts: cuts.existingCuts, acceptedMain, cutBase, commit, source,
      ...(services.collectMachinery ? { machinery: machinery.map(row => ({ ...row, rule: receiptDigest([row.rule, policy, cutRows]) })) } : {}) };
  });
  if (result?.unavailable) throw new Refused('CELLS_SUBMIT', result.unavailable);
  if (receiptKey && !samePreloads()) throw new Refused('CELLS_SUBMIT', 'Node preload changed during cell analysis; restore it and retry');
  if (receiptKey && receiptDigest(services.readCutItems?.(acceptedMain, root)) === receiptDigest(cutRows)) writeCheckReceipt(root, receiptKey, { result });
  return result;
}

/** Keep compiler protocol files inside the cells cache during object-only submit analysis. */
function withSubmitCellParser(work) {
  const directory = cellsCacheDirectory('parser');
  return withSubmitParseCache(() => withCellLintParser(work, { directory }), { directory });
}
