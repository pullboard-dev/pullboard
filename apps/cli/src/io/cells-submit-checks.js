import { withImportParseCache as withSubmitParseCache } from '../../../../packages/gate/heavy.js';
import { withCellGitObjects } from '../../../../packages/codemap/index.js';
import { cellsObjectSnapshots } from '../../../../packages/codemap/index.js';
import { withCellSourceSnapshots } from '../../../../packages/codemap/index.js';
import { shimCountProblems } from '../../../../packages/codemap/light.js';
import { shimImportProblems } from '../../../../packages/codemap/index.js';
import { withCellLintParser } from '../../../../packages/codemap/index.js';
import { cellsCacheDirectory } from '../../../../packages/codemap/index.js';
import { inventoryCache } from './cells/cache-door.js';
import { observationCache } from './cells/cache-door.js';
import { acceptedCellsIdentity } from '../../../../packages/gate/heavy.js';
import { readAcceptedCells } from '../../../../packages/gate/heavy.js';
import { inventoryPending } from './cells/cache-door.js';
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
import {
  onlyForwards,
  withDeclaredLoads,
} from '../../../../packages/codemap/index.js';
import { checkMoved } from '../../../../packages/codemap/index.js';
import { lightFrontDoorProblems } from '../../../../packages/codemap/index.js';
import { pureDoorProblems } from '../../../../packages/codemap/index.js';
import { pureFrontDoorProblems } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { shardFile } from '../../../../packages/codemap/index.js';
import { scriptMentions } from '../../../../packages/codemap/index.js';
import { testFile } from '../../../../packages/codemap/index.js';
import { posix } from 'node:path';
import { cellOfFolder } from '../logic/cell-of-folder.js';
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

/** Read only landed core cut items (titles `Cells import cuts: <cell> ...`), so the runner request carries a few rows, not the board [C7]. */
export function landedCutItemRows(db) {
  return db.prepare(`SELECT item_id, item_lane, item_title, item_status, item_merged_commit FROM item
    WHERE item_lane='core' AND item_status='verified' AND item_merged_commit IS NOT NULL AND item_title LIKE 'Cells import cuts: % removes imports into later cells'
    AND NOT EXISTS (SELECT 1 FROM board_meta WHERE meta_key='item_redirect:' || item_id)`).all();
}

/** A malformed analysis is a refusal, never an empty set of findings. */
function refuse(problems) {
  if (problems.length) throw new Refused('CELLS_SUBMIT', problems.join('; '));
}

/** Cell identity, order and door rules; stays, entries and row ownership are no longer read from the plan [C7]. */
export function policyProblems(before, after, beforeMap, afterMap, candidateRoot, mainRoot, criterion = '') {
  const problems = [], cells = new Map(after.cells.map(cell => [cell.name, cell]));
  const orders = new Set(), roots = new Set();
  const relative = value => typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
  for (const cell of after.cells) {
    if (!Number.isSafeInteger(cell.order) || cell.order < 1 || orders.has(cell.order)) problems.push(`invalid or duplicate cell order: ${cell.name}`);
    orders.add(cell.order);
    if (!relative(cell.root) || !relative(cell.frontDoor) || !cell.frontDoor.startsWith(cell.root + '/')) problems.push(`invalid cell root/front door: ${cell.name}`);
    if ([...roots].some(root => root === cell.root || root.startsWith(cell.root + '/') || cell.root.startsWith(root + '/'))) problems.push(`overlapping cell root: ${cell.root}`);
    roots.add(cell.root);
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

/**
 * Whether the cell owns a path the move maps carry, found from the target's folder, never from the plan's path rows [C7,#8742].
 *
 * Why: the plan rows are being retired, and a folder already names the cell.
 *
 * @param {string} name cell name
 * @param {Array<Map<string, string>>} maps path maps (from to target), one per side
 * @returns {boolean}
 */
export function cellHasMovedPaths(name, maps) {
  return maps.some(map => [...map.values()].some(to => cellOfFolder(to) === name));
}

/** Attribute changed cells and their direct importers against both immutable graphs. */
export function touchedCells(files, before, after, inventories) {
  const plans = [before, after];
  // Shared metadata or an unowned root-tool stay can alter every reachable cell.
  const scope = policyScope(files, plans);
  if (scope.all) {
    return after.cells.map(cell => cell.name);
  }
  const known = new Set(plans.flatMap(plan => plan.cells.map(cell => cell.name)));
  const byPath = new Map();
  /** A path's cell comes from its folder, never from the plan's rows; only a cell the plans name counts [#8555]. */
  const owners = file => {
    if (!byPath.has(file)) { const name = cellOfFolder(file); byPath.set(file, name !== null && known.has(name) ? [name] : []); }
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
  const machinery = [];
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
  // A file that newly only forwards is a shim even outside any planned cell's folder, so the shim count still runs for it [C7].
  const addsShim = changed.some(file => {
    const text = shimSnapshotFile(candidateRoot, file);
    const was = shimSnapshotFile(mainRoot, file);
    return text !== undefined && onlyForwards(text, false) && !(was !== undefined && onlyForwards(was, false));
  });
  if (!direct.length && !addsShim) return { cells: [], problems: policy, warnings, reorg, ...(collectMachinery ? { machinery } : {}) };
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
    const moved = cellHasMovedPaths(name, [mainMap, candidateMap]);
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
    const result = withSubmitCellParser(() => cellsSnapshotProblems(mainRoot, candidateRoot, { acceptedMain, criterion, title, parsers, withImportParseCache, cacheEligible: samePreloads, inventories, observations: observations.values, warmAll: false, collectMachinery: services.collectMachinery === true, onBindingProbe: services.onBindingProbe, onAllCells: services.onAllCells, runtimeIdentity: artifact.runtimeIdentity }));
    unchangedSnapshot(mainRoot, acceptedMain);
    unchangedSnapshot(candidateRoot, commit);
    observations.commit();
    const problems = [...result.problems];
    const machinery = [...result.machinery ?? []];
    if (services.collectMachinery && problems.length) machinery.push({ kind: 'plan', code: 'CELLS_SUBMIT', message: problems.join('; '), rule: receiptDigest(readFileSync(fileURLToPath(import.meta.url), 'utf8')) });
    else refuse(problems);
    const warnings = [...result.warnings];
    const policy = services.collectMachinery && existsSync(join(mainRoot, 'packages/codemap/data/plan/cells.json')) ? readPlan(mainRoot) : null;
    return { ...result, warnings, existingCuts: [], acceptedMain, cutBase, commit, source,
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
