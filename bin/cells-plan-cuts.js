/** Shell boundary for checking actual import cuts and filing their independent board items [C7,D3]. */
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';
import { spawnSync } from 'node:child_process';
import { cellInventory } from '../packages/codemap/index.js';
import { testFile } from '../packages/codemap/index.js';
import { temporaryCellEdges } from '../packages/codemap/index.js';
import { declaredSourceLoads } from '../src/affected-tests.js';
import { declaredSourcePatterns } from '../src/affected-tests.js';
import { cutItemCommands } from '../packages/codemap/index.js';
import { cutTitle } from '../packages/codemap/index.js';
import { importCuts } from '../packages/codemap/index.js';
import { retiredRows } from '../packages/codemap/src/core/cells-plan-cuts.js';
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryImport } from '../packages/codemap/src/core/import-map.js';
import { lex } from '../src/js-lex.js';
import { readPathMap } from '../packages/codemap/index.js';
import { mappedPath } from '../packages/codemap/index.js';
import { Refused } from '../src/refused.js';

/** Attribute original paths, moved identities and front doors to their committed plan cell. */
function ownerFor(plan, map) {
  const paths = new Map();
  for (const cell of plan.cells) {
    paths.set(cell.frontDoor, cell.name);
    for (const [from, to] of cell.paths) for (const file of [from, to, mappedPath(map, from)]) paths.set(file, cell.name);
  }
  const entries = new Map();
  for (const entry of plan.entries ?? []) for (const file of [entry.path, mappedPath(map, entry.path)]) entries.set(file, entry.cell);
  return file => entries.get(file) ?? plan.cells.find(cell => file.startsWith(`${cell.root}/`))?.name ?? paths.get(file) ?? null;
}

/** Find a condition's matching parenthesis in lexed code, without interpreting quoted examples. */
function closeParenthesis(code, start) {
  let depth = 0;
  for (let at = start; at < code.length; at++) {
    if (code[at] === '(') depth++;
    if (code[at] === ')' && --depth === 0) return at;
  }
  return -1;
}

/** Recognize a literal Node binding rather than a similarly named fixture or local callback. */
function nodeBinding(parsed, module, name) {
  return parsed.strings.some(row => row.text === module &&
    /\bimport\s*\{([^{}]*)\}\s*from\s*$/u.exec(parsed.code.slice(0, row.start))?.[1]
      .split(',').some(binding => binding.trim() === name));
}

/** Prove an own-file main guard, or a non-exporting Node script that actually awaits its program. */
function processEntry(file, source) {
  const parsed = lex(source), code = parsed.code;
  if (/\b(?:const|let|var|function|class)\s+process\b/u.test(code)) return false;
  const identities = [];
  if (nodeBinding(parsed, 'node:url', 'fileURLToPath')) {
    const targets = ['fileURLToPath(import.meta.url)', ...[...code.matchAll(/\bconst\s+([\w$]+)\s*=\s*fileURLToPath\s*\(\s*import\s*\.\s*meta\s*\.\s*url\s*\)\s*;/gu)].map(row => row[1])];
    for (const target of targets) {
      identities.push(`process.argv[1]===${target}`);
      if (nodeBinding(parsed, 'node:path', 'resolve')) identities.push(`resolve(process.argv[1])===${target}`);
    }
  }
  let depth = 0, start = 0, processInput = false;
  for (let at = 0; at < code.length; at++) {
    if (code[at] === '{') depth++;
    if (code[at] === '}') depth--;
    if (depth === 0 && /[;}]/u.test(code[at])) start = at + 1;
    if (depth === 0 && /^if\s*\(/u.test(code.slice(at)) && !/[\w$]/u.test(code[at - 1] ?? '')) {
      const open = code.indexOf('(', at), end = closeParenthesis(code, open);
      const condition = code.slice(open + 1, end).replace(/\s/gu, '');
      if (end > open && !/[!?]|\|\|/u.test(condition) && condition.split('&&').some(part => identities.includes(part))) return true;
    }
    if (depth !== 0 || !code.startsWith('process', at) || /[\w$.]/u.test(code[at - 1] ?? '')) continue;
    const tail = code.slice(at), prefix = code.slice(start, at);
    if (!/^process\s*\.\s*(?:argv|send)\b/u.test(tail) || prefix.includes('=>') || /^\s*export\b/u.test(prefix)) continue;
    processInput = true;
  }
  return file.startsWith('bin/') && /^#!\/usr\/bin\/env node\b/u.test(source) && processInput
    && !/\b(?:export|function|class)\b|\basync\s*(?:\([^)]*\)|[\w$]+)\s*(?:=>|\()/u.test(code)
    && /\bawait\s+[\w$]+\s*\(/u.test(code);
}

/** Entry ownership is explicit app composition, backed by the actual process source on every check. */
export function entryPlacementProblems(root, plan, files) {
  if (plan.entries === undefined) return [];
  if (!Array.isArray(plan.entries)) return ['process entries must be an array'];
  const problems = [], seen = new Set(), map = readPathMap(root);
  for (const row of plan.entries) {
    const cell = plan.cells.find(cell => cell.name === row?.cell);
    if (!row || Object.keys(row).sort().join(',') !== 'cell,path' || typeof row.path !== 'string'
      || !/^(?:bin|src|relay)\/.+\.[cm]?js$/u.test(row.path) || row.path.split('/').some(part => !part || part === '.' || part === '..')
      || /[\\\0\r\n]/u.test(row.path) || !cell?.name.startsWith('app:') || seen.has(row.path)) {
      problems.push('each process entry needs one unique path and an existing app cell'); continue;
    }
    seen.add(row.path);
    const placed = cell.paths.some(([from]) => from === row.path)
      || plan.stays.some(stay => stay.path === row.path);
    let source;
    const file = mappedPath(map, row.path);
    try {
      if (files) source = files.get(file)?.toString('utf8');
      else if (lstatSync(join(root, file)).isFile()) source = readFileSync(join(root, file), 'utf8');
    } catch { /* Missing or non-regular entry source is refused below, without trusting its metadata. */ }
    let executable = false;
    try { if (typeof source === 'string' && processEntry(row.path, source)) { importsIn([source]); executable = true; } }
    catch { /* Invalid module bytes cannot establish a process boundary. */ }
    if (!placed || !executable) {
      problems.push(`${row.path} is not a placed process entry; ordinary library ownership cannot be overridden`);
    }
  }
  return problems;
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
function withDeclaredLoads(files, edges, unknown, acceptedInventory) {
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
export function checkCuts(root, plan, name, { allLaterCells = false, temporaryExceptions = true, inventory: sharedInventory, acceptedInventory } = {}) {
  if (typeof allLaterCells !== 'boolean' || typeof temporaryExceptions !== 'boolean') throw new TypeError('cut modes must be explicit booleans');
  const cell = plan.cells.find(row => row.name === name);
  const group = importCuts(plan).find(row => row.cell === name);
  if (!cell || !group && !allLaterCells) throw new Refused('CELLS_PLAN_CELL', `no import-cut group ${name}; use an importing cell from node bin/cells-plan.js --file-cuts`);
  const inventory = sharedInventory ?? cellInventory(root, { importsIn, commonJsIn });
  const { files } = inventory;
  const entries = entryPlacementProblems(root, plan, files);
  if (entries.length) return entries;
  if (acceptedInventory !== undefined && !(acceptedInventory?.files instanceof Map)) throw new TypeError('accepted cut inventory must be an actual snapshot');
  const { edges, unknown, computed } = withDeclaredLoads(files, inventory.edges, inventory.unknown, acceptedInventory);
  const map = readPathMap(root);
  const owner = ownerFor(plan, map);
  const temporary = temporaryCellEdges(files);
  const allowed = new Set(!temporaryExceptions || temporary.problems.length ? [] : temporary.edges.map(row => `${mappedPath(map, row.importer)}->${mappedPath(map, row.target)}`));
  const forbidden = new Set(allLaterCells ? plan.cells.filter(row => row.order > cell.order).map(row => row.name) : group.targets);
  const problems = new Set([...temporary.problems, ...retiredProblems(root, plan, inventory)]), seen = new Set();
  const pending = [...edges.keys()].filter(file => !testFile(file) && owner(file) === name);
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const unresolved = unknown.filter(row => row.file === file);
    const cell = owner(file);
    if (cell !== name && !(allLaterCells && cell === null) && !onlyForwards(files.get(file)?.toString('utf8') ?? '',
      computed.has(file))) continue;
    for (const row of unresolved) problems.add(`cannot prove cut through ${file}: ${row.reason}`);
    for (const { target, acceptedWildcard } of edges.get(file) ?? []) {
      if (testFile(target)) continue;
      const cell = owner(target);
      if (forbidden.has(cell) && !acceptedWildcard && !allowed.has(`${file}->${target}`)) problems.add(`${name} still imports later ${cell}: ${file} -> ${target}`);
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
