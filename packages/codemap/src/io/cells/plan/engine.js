/**
 * Shell boundary for checking actual import cuts [C7,D3]. Codemap owns it: it needs only the module parsers and declared loads.
 * The path-map reader is an option: a caller that pins a source snapshot passes its own reader, others get the committed one.
 */
import { importsIn } from '../../../../index.js';
import { commonJsIn } from '../../../../index.js';
import { planEntryProblems as entryPlacementProblems } from '../../../../index.js';
import { retiredProblems } from '../../../../index.js';
import { readPathMap as committedPathMap } from '../../../../index.js';
import { cellInventory } from '../../../../index.js';
import { testFile } from '../../../../index.js';
import { temporaryCellEdges } from '../../../../index.js';
import { declaredSourceLoads } from '../../../../index.js';
import { declaredSourcePatterns } from '../../../../index.js';
import { importCuts } from '../../../../index.js';
import { lex } from '../../../../../kernel/index.js';
import { mappedPath } from '../../../../index.js';
import { Refused } from '../../../../../kernel/index.js';

/** Attribute original paths, moved identities and front doors to their committed plan cell. */
export function ownerFor(plan, map) {
  const paths = new Map();
  for (const cell of plan.cells) {
    paths.set(cell.frontDoor, cell.name);
    for (const [from, to] of cell.paths) for (const file of [from, to, mappedPath(map, from)]) paths.set(file, cell.name);
  }
  const entries = new Map();
  for (const entry of plan.entries ?? []) for (const file of [entry.path, mappedPath(map, entry.path)]) entries.set(file, entry.cell);
  // An owned stay keeps its path but belongs to its owner cell, so a lower cell importing it imports that cell.
  for (const stay of plan.stays ?? []) if (typeof stay?.owner === 'string' && !entries.has(stay.path)) entries.set(stay.path, stay.owner);
  return file => entries.get(file) ?? plan.cells.find(cell => file.startsWith(`${cell.root}/`))?.name ?? paths.get(file) ?? null;
}

/**
 * The placement problems a merged tree adds over base main: tracked bin/ or src/ sources with no plan row, and process
 * entries without a stays row. Why: three files landed unplaced on 6 Nov and turned every later gate red [C7].
 * The readers are passed in because cells-plan.js imports this module.
 */
export function addedPlacementProblems(baseRoot, mergedRoot, { unplanned, readPlan, readPathMap = committedPathMap }) {
  const found = root => {
    const plan = readPlan(root);
    return [...unplanned(root, plan).map(path => ({ path, message: `${path} has no cells-plan row` })),
      ...entryPlacementProblems(root, plan, undefined, undefined, readPathMap).map(message => ({ path: message.split(' ')[0], message }))];
  };
  const before = new Set(found(baseRoot).map(row => row.message));
  return found(mergedRoot).filter(row => !before.has(row.message));
}

/** Results of the forwarding check by source: it is pure and the cut sweep asks it once per cell. */
const forwardsMemo = new Map();

/** Recognize a module that only passes imports onward, including an unresolved computed loader. */
export function onlyForwards(source, computed) {
  const key = `${computed ? 1 : 0}${source}`;
  if (!forwardsMemo.has(key)) forwardsMemo.set(key, onlyForwardsUncached(source, computed));
  return forwardsMemo.get(key);
}

/** The uncached forwarding check behind onlyForwards. */
function onlyForwardsUncached(source, computed) {
  const chars = source.split('');
  for (const { start, end } of lex(source).comments) chars.fill(' ', start, end);
  const code = chars.join('').replace(/\s/gu, '');
  return /^(?:export(?:\*(?:as\w+)?|\{[^}]*\})from(?:'[^']*'|"[^"]*");?)+$/u.test(code)
    || computed && /^(?:await)?import\([^;]*\);?$/u.test(code);
}

/** Expand strict declared loaders while retaining their original forwarding identity and unrelated unknowns. */
export function withDeclaredLoads(files, edges, unknown, acceptedInventory) {
  const modules = [...files.keys()].filter(file => /\.[cm]?js$/u.test(file));
  const declared = new Map(), rest = [];
  const acceptedModules = acceptedInventory ? [...acceptedInventory.files.keys()].filter(file => /\.[cm]?js$/u.test(file)) : [];
  /** Existing wildcard authority is a declaration, not a separate new import for every future matching file. */
  function acceptedWildcardTargets(file) {
    const previous = acceptedInventory?.files.get(file);
    if (!previous) return new Set();
    const oldPatterns = declaredSourcePatterns(previous.toString('utf8'), acceptedModules);
    const current = declaredSourcePatterns(files.get(file)?.toString('utf8') ?? '', modules);
    if (!oldPatterns || !current) return new Set();
    const patterns = current.filter(pattern => /[*?]/u.test(pattern) && oldPatterns.includes(pattern));
    if (!patterns.length) return new Set();
    return new Set(declaredSourceLoads(`/** @pullboard-module-loads ${patterns.join(' ')} */\n`, modules) ?? []);
  }
  const computed = new Set(unknown.filter(row => row.reason.includes('computed loader')).map(row => row.file));
  for (const row of unknown) {
    if (row.specifier !== '(computed)') { rest.push(row); continue; }
    if (!declared.has(row.file)) declared.set(row.file, declaredSourceLoads(files.get(row.file)?.toString('utf8') ?? '', modules) ?? []);
    if (!declared.get(row.file).length) rest.push(row);
  }
  const merged = new Map(edges);
  for (const [file, loads] of declared) {
    const accepted = acceptedWildcardTargets(file);
    if (loads.length) merged.set(file, [...(edges.get(file) ?? []), ...loads.filter(target => target !== file)
      .map(target => ({ target, specifier: '(computed)', acceptedWildcard: accepted.has(target) }))]);
  }
  return { edges: merged, unknown: rest, computed };
}

/** Follow this cell's imports and forwarding modules, leaving another cell's own imports to its cut. */
export function checkCuts(root, plan, name, { allLaterCells = false, temporaryExceptions = true, inventory: sharedInventory, acceptedInventory, shared, readPathMap = committedPathMap } = {}) {
  if (typeof allLaterCells !== 'boolean' || typeof temporaryExceptions !== 'boolean') throw new TypeError('cut modes must be explicit booleans');
  const cell = plan.cells.find(row => row.name === name);
  const group = (shared?.groups ?? importCuts(plan)).find(row => row.cell === name);
  if (!cell || !group && !allLaterCells) throw new Refused('CELLS_PLAN_CELL', `no import-cut group ${name}; use an importing cell from node packages/codemap/src/io/cells/scripts/plan.js --file-cuts`);
  const inventory = sharedInventory ?? cellInventory(root, { importsIn, commonJsIn });
  const { files } = inventory;
  const entries = shared?.entries ?? entryPlacementProblems(root, plan, files, shared?.map, readPathMap);
  if (entries.length) return entries;
  if (acceptedInventory !== undefined && !(acceptedInventory?.files instanceof Map)) throw new TypeError('accepted cut inventory must be an actual snapshot');
  const { edges, unknown, computed } = withDeclaredLoads(files, inventory.edges, inventory.unknown, acceptedInventory);
  const map = shared?.map ?? readPathMap(root);
  const owner = ownerFor(plan, map);
  const temporary = temporaryCellEdges(files);
  const allowed = new Set(!temporaryExceptions || temporary.problems.length ? [] : temporary.edges.map(row => `${mappedPath(map, row.importer)}->${mappedPath(map, row.target)}`));
  const forbidden = new Set(allLaterCells ? plan.cells.filter(row => row.order > cell.order).map(row => row.name) : group.targets);
  const problems = new Set([...temporary.problems, ...(shared?.retired ?? retiredProblems(root, plan, inventory))]), seen = new Set();
  // Test support may depend on any cell, but executable production must never depend on testkit.
  for (const [file, imports] of inventory.edges) {
    if (testFile(file)) continue;
    for (const row of imports) {
      if (!row.kind && (row.target === 'packages/testkit/index.js' || row.target.startsWith('packages/testkit/src/'))) {
        problems.add(`production imports testkit: ${file} -> ${row.target}`);
      }
    }
  }
  /** @type {{ file: string, wildcardCell: string | null }[]} */
  const pending = [...edges.keys()].filter(file => !testFile(file) && owner(file) === name)
    .map(file => ({ file, wildcardCell: null }));
  while (pending.length) {
    const { file, wildcardCell } = pending.pop();
    const identity = JSON.stringify([file, wildcardCell]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const unresolved = unknown.filter(row => row.file === file);
    const cell = owner(file);
    if (cell !== name && !(allLaterCells && cell === null) && !onlyForwards(files.get(file)?.toString('utf8') ?? '',
      computed.has(file))) continue;
    for (const row of unresolved) problems.add(`cannot prove cut through ${file}: ${row.reason}`);
    for (const { target, acceptedWildcard } of edges.get(file) ?? []) {
      if (testFile(target)) continue;
      const cell = owner(target);
      // An existing wildcard's target may move behind exact same-cell re-export shims.
      // Preserve only that target's cell through pure exports; computed loaders and real
      // implementations never inherit it, nor can an independent literal importing path.
      const forwardedCell = wildcardCell !== null && owner(file) === wildcardCell && cell === wildcardCell
        && onlyForwards(files.get(file)?.toString('utf8') ?? '', false) ? wildcardCell : null;
      if (forbidden.has(cell) && !acceptedWildcard && forwardedCell === null && !allowed.has(`${file}->${target}`)) problems.add(`${name} still imports later ${cell}: ${file} -> ${target}`);
      else pending.push({ file: target, wildcardCell: acceptedWildcard ? cell : forwardedCell });
    }
  }
  return [...problems].sort();
}

/** Lower-cell imports that skip the lower cell's front door (index.js or core.js), keyed by moved-path-stable identity.
 *  Why: DR12 seals a cell's boundary once its cut lands; submit compares these rows with accepted main so only additions refuse. */
export function frontDoorBypasses(root, plan, name, { inventory: sharedInventory, acceptedInventory, readPathMap = committedPathMap } = {}) {
  const cell = plan.cells.find(row => row.name === name);
  if (!cell) throw new Refused('CELLS_PLAN_CELL', `no cell ${name}; use a cell from node packages/codemap/src/io/cells/scripts/plan.js --cuts <cell>`);
  const inventory = sharedInventory ?? cellInventory(root, { importsIn, commonJsIn });
  const entries = entryPlacementProblems(root, plan, inventory.files, undefined, readPathMap);
  if (entries.length) throw new Refused('CELLS_ENTRY', entries.join('; '));
  const { edges } = withDeclaredLoads(inventory.files, inventory.edges, inventory.unknown, acceptedInventory);
  const map = readPathMap(root), owner = ownerFor(plan, map);
  const origin = new Map([...map].map(([from, to]) => [to, from]));
  const stable = file => origin.get(file) ?? file;
  const rows = new Map();
  for (const [file, imports] of edges) {
    if (testFile(file) || owner(file) !== name) continue;
    for (const { target, acceptedWildcard } of imports) {
      if (testFile(target) || acceptedWildcard) continue;
      const lower = plan.cells.find(row => row.name === owner(target));
      if (!lower || lower.order >= cell.order || target === lower.frontDoor || target === `${lower.root}/light.js` || target === `${lower.root}/browser.js`) continue;
      rows.set(`${stable(file)}->${stable(target)}`, `${name} imports lower ${lower.name} past its front door ${lower.frontDoor}: ${file} -> ${target}`);
    }
  }
  return rows;
}

