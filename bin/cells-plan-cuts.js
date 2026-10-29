/** Shell boundary for checking actual import cuts and filing their independent board items [C7,D3]. */
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';
import { spawnSync } from 'node:child_process';
import { cellInventory } from '../src/cell-lint-inventory.js';
import { testFile } from '../src/cell-lint-inventory.js';
import { temporaryCellEdges } from '../src/cell-lint-inventory.js';
import { declaredSourceLoads } from '../src/affected-tests.js';
import { cutItemCommands } from '../src/cells-plan-cuts.js';
import { cutTitle } from '../src/cells-plan-cuts.js';
import { importCuts } from '../src/cells-plan-cuts.js';
import { retiredRows } from '../packages/codemap/src/core/cells-plan-cuts.js';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryImport } from '../packages/codemap/src/core/import-map.js';
import { lex } from '../src/js-lex.js';
import { readPathMap } from '../src/path-map.js';
import { mappedPath } from '../src/path-map.js';
import { Refused } from '../src/refused.js';

/** Attribute original paths, moved identities and front doors to their committed plan cell. */
function ownerFor(plan, map) {
  const paths = new Map();
  for (const cell of plan.cells) {
    paths.set(cell.frontDoor, cell.name);
    for (const [from, to] of cell.paths) for (const file of [from, to, mappedPath(map, from)]) paths.set(file, cell.name);
  }
  return file => plan.cells.find(cell => file.startsWith(`${cell.root}/`))?.name ?? paths.get(file) ?? null;
}

/** Recognize a module that only passes imports onward, including an unresolved computed loader. */
function onlyForwards(source, computed) {
  const chars = source.split('');
  for (const { start, end } of lex(source).comments) chars.fill(' ', start, end);
  const code = chars.join('').replace(/\s/gu, '');
  return /^(?:export(?:\*(?:as\w+)?|\{[^}]*\})from(?:'[^']*'|"[^"]*");?)+$/u.test(code)
    || computed && /^(?:await)?import\([^;]*\);?$/u.test(code);
}

/** Expand strict declared loaders while retaining their original forwarding identity and unrelated unknowns. */
function withDeclaredLoads(files, edges, unknown) {
  const modules = [...files.keys()].filter(file => /\.[cm]?js$/u.test(file));
  const declared = new Map(), rest = [];
  const computed = new Set(unknown.filter(row => row.reason.includes('computed loader')).map(row => row.file));
  for (const row of unknown) {
    if (row.specifier !== '(computed)') { rest.push(row); continue; }
    if (!declared.has(row.file)) declared.set(row.file, declaredSourceLoads(files.get(row.file)?.toString('utf8') ?? '', modules) ?? []);
    if (!declared.get(row.file).length) rest.push(row);
  }
  const merged = new Map(edges);
  for (const [file, loads] of declared) {
    if (loads.length) merged.set(file, [...(edges.get(file) ?? []), ...loads.filter(target => target !== file).map(target => ({ target, specifier: '(computed)' }))]);
  }
  return { edges: merged, unknown: rest, computed };
}

/** A historical anchor is retired only while neither endpoint exists or has a live resolved import. */
export function retiredProblems(root, plan, inventory) {
  const rows = retiredRows(plan);
  if (!rows.length) return [];
  const { files, edges, unknown } = inventory ?? cellInventory(root, { importsIn, commonJsIn });
  const endpoints = new Set(rows.flatMap(entry => entry.row.slice(0, 2)));
  const config = files.has('package.json') ? JSON.parse(files.get('package.json').toString('utf8')) : {};
  const problems = [];
  for (const path of endpoints) {
    let present = files.has(path);
    try { lstatSync(join(root, path)); present = true; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (present) problems.push(`retired historical path still exists: ${path}`);
  }
  for (const [file, imports] of edges) for (const { target } of imports) {
    if (endpoints.has(target)) problems.push(`live import of retired historical path: ${file} -> ${target}`);
  }
  for (const { file, specifier } of unknown) {
    if (typeof specifier !== 'string') continue;
    const target = repositoryImport(file, specifier, config.imports);
    if (endpoints.has(target)) problems.push(`live import of absent retired historical path: ${file} -> ${target}`);
  }
  return [...new Set(problems)].sort();
}

/** Follow this cell's imports and forwarding modules, leaving another cell's own imports to its cut. */
export function checkCuts(root, plan, name) {
  const group = importCuts(plan).find(row => row.cell === name);
  if (!group) throw new Refused('CELLS_PLAN_CELL', `no import-cut group ${name}; use an importing cell from node bin/cells-plan.js --file-cuts`);
  const inventory = cellInventory(root, { importsIn, commonJsIn });
  const { files } = inventory;
  const { edges, unknown, computed } = withDeclaredLoads(files, inventory.edges, inventory.unknown);
  const map = readPathMap(root);
  const owner = ownerFor(plan, map);
  const temporary = temporaryCellEdges(files);
  const allowed = new Set(temporary.problems.length ? [] : temporary.edges.map(row => `${mappedPath(map, row.importer)}->${mappedPath(map, row.target)}`));
  const forbidden = new Set(group.targets), problems = new Set([...temporary.problems, ...retiredProblems(root, plan, inventory)]), seen = new Set();
  const pending = [...edges.keys()].filter(file => !testFile(file) && owner(file) === name);
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const unresolved = unknown.filter(row => row.file === file);
    const cell = owner(file);
    if (cell !== name && !onlyForwards(files.get(file)?.toString('utf8') ?? '',
      computed.has(file))) continue;
    for (const row of unresolved) problems.add(`cannot prove cut through ${file}: ${row.reason}`);
    for (const { target } of edges.get(file) ?? []) {
      if (testFile(target)) continue;
      const cell = owner(target);
      if (forbidden.has(cell) && !allowed.has(`${file}->${target}`)) problems.add(`${name} still imports later ${cell}: ${file} -> ${target}`);
      else pending.push(target);
    }
  }
  return [...problems].sort();
}

/** Read existing items through the real joined CLI; one exact stable title identifies one importing cell's item. */
function existingCuts(root, plan) {
  const run = spawnSync('pullboard', ['list', 'core', '--all', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Refused('CELLS_PLAN_FILE', `pullboard list failed: ${run.stderr?.trim()}; use a joined checkout`);
  const items = JSON.parse(run.stdout).items ?? [];
  const ids = new Map();
  for (const group of importCuts(plan)) {
    const found = items.find(item => item.item_title === cutTitle(group.cell));
    if (found) ids.set(group.cell, String(found.item_id));
  }
  return ids;
}

/** Dry-run or file missing cut items, retaining completed adds when an interrupted invocation is rerun. */
export function fileCuts(root, plan, yes) {
  const ids = existingCuts(root, plan);
  for (const [cell, id] of ids) console.log(`${cell} import cuts already #${id}`);
  for (const { group, args } of cutItemCommands(plan, ids)) {
    if (!yes) { console.log(['pullboard', ...args.map(arg => JSON.stringify(arg))].join(' ')); continue; }
    const run = spawnSync('pullboard', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (run.status !== 0) throw new Refused('CELLS_PLAN_FILE', `pullboard add for ${group.cell} cuts failed: ${run.stderr?.trim()}; fix it and rerun to skip filed items`);
    const id = /"item_id"\s*:\s*(\d+)/u.exec(run.stdout)?.[1] ?? /#(\d+)/u.exec(run.stdout)?.[1];
    if (!id) throw new Refused('CELLS_PLAN_FILE', `pullboard add for ${group.cell} cuts printed no id; inspect the board before rerunning`);
    console.log(`${group.cell} import cuts #${id}`);
  }
  if (!yes) console.log('dry run: nothing filed; add --yes to file independent import-cut items');
}
