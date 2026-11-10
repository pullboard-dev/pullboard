/** Plan placement checks: process entries, stay owners and retired historical paths [C7,D3,CD60,CD64]. */
import { join } from 'node:path';
import { lex } from '../../../kernel/index.js';
import { cellLstatSync as lstatSync } from './cell/snapshot.js';
import { cellReadFileSync as readFileSync } from './cell/snapshot.js';
import { cellInventory } from './cell/lint/inventory.js';
import { importsIn } from './module/imports.js';
import { commonJsIn } from './module/imports.js';
import { readPathMap as committedPathMap } from '../logic/path/map.js';
import { mappedPath } from '../logic/path/map.js';
import { repositoryImport } from '../logic/imports.js';
import { retiredRows } from '../logic/cuts.js';

/** Name each stay row whose owner is not an existing cell, or whose fields are not exactly path, reason and owner. */
export function ownedStayProblems(plan) {
  const names = new Set(plan.cells.map(cell => cell.name));
  return (plan.stays ?? []).filter(stay => stay && Object.hasOwn(stay, 'owner'))
    .filter(stay => Object.keys(stay).sort().join(',') !== 'owner,path,reason' || typeof stay.owner !== 'string' || !names.has(stay.owner))
    .map(stay => `stay ${stay.path} names owner ${JSON.stringify(stay.owner)}, which is not a cell in the plan`);
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
export function processEntry(file, source) {
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
export function entryPlacementProblems(root, plan, files, sharedMap = undefined, readPathMap = committedPathMap) {
  if (plan.entries === undefined) return [];
  if (!Array.isArray(plan.entries)) return ['process entries must be an array'];
  const problems = [], seen = new Set(), map = sharedMap ?? readPathMap(root);
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
