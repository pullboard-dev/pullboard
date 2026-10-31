/** Remove one cell's re-export shims: repoint every importer to the cell front door, then delete what nothing imports [C7,D3]. */
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';
import { cellInventory } from '../packages/codemap/index.js';
import { readPathMap } from '../packages/codemap/index.js';
import { repositoryImport } from '../packages/codemap/index.js';
import { testFile } from '../packages/codemap/index.js';
import { loadConfig } from '../packages/config/index.js';
import { tryGit } from '../packages/git/index.js';
import { lex } from '../packages/kernel/index.js';
import { laneOf } from '../packages/seats/index.js';
import { Refused } from '../packages/kernel/index.js';
import { checkCuts } from './cells-plan-cuts.js';
import { ownerFor } from './cells-plan-cuts.js';

/** Marks a use that takes the shim's whole namespace, so every name it exports must stay reachable. */
const ALL = Symbol('all');
/** A shim holds only re-export statements; anything else is code and stays. */
const PURE_SHIM = /^(?:export(?:\*|\{[^}]*\})from(?:'[^']*'|"[^"]*");)+$/u;

/** Resolve a specifier written in `file` to a repository path, or null for a builtin or an unknown package. */
function resolveSpec(box, file, text) {
  return text.startsWith('node:') ? null : repositoryImport(file, text, box.imports) ?? null;
}

/** Lex a module once: code with literals blanked, the literal table, and a start-offset index. */
function scan(source) {
  const info = lex(source);
  return { ...info, byStart: new Map(info.strings.map(row => [row.start, row])) };
}

/** The string literal opening at the next code character after `at`, if any. */
function literalAfter(info, at) {
  let next = at;
  while (next < info.code.length && /\s/u.test(info.code[next])) next++;
  return info.byStart.get(next) ?? null;
}

/** Every name a module exports with the module and name that define it, following export-star chains. */
function exportsOf(box, file, seen = new Set()) {
  const names = new Map(), bytes = box.files.get(file);
  if (!bytes || seen.has(file)) return names;
  const info = scan(bytes.toString('utf8')), chain = new Set(seen).add(file);
  for (const match of info.code.matchAll(/\bexport\s*\{([^}]*)\}\s*(from\s*)?/gu)) {
    const literal = match[2] ? literalAfter(info, match.index + match[0].length) : null;
    const module = literal ? resolveSpec(box, file, literal.text) : file;
    for (const part of match[1].split(',').map(value => value.trim()).filter(Boolean)) {
      const row = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/u.exec(part);
      if (row && module) names.set(row[2] ?? row[1], { module, name: literal ? row[1] : row[2] ?? row[1] });
    }
  }
  for (const match of info.code.matchAll(/\bexport\s*\*\s*(?:as\s+([\w$]+)\s*)?from\s*/gu)) {
    const literal = literalAfter(info, match.index + match[0].length);
    const module = literal && resolveSpec(box, file, literal.text);
    if (!module) continue;
    if (match[1]) names.set(match[1], { module: file, name: match[1] });
    else for (const [name, row] of exportsOf(box, module, chain)) if (name !== 'default' && !names.has(name)) names.set(name, row);
  }
  for (const match of info.code.matchAll(/\bexport\s+(?:async\s+)?(?:(?:const|let|var|class)\s+|function\s*\*?\s*)([\w$]+)/gu)) names.set(match[1], { module: file, name: match[1] });
  if (/\bexport\s+default\b/u.test(info.code)) names.set('default', { module: file, name: 'default' });
  return names;
}

/** What an importer takes at one literal: its kind and binding names (or ALL), or null when the site is not understood. */
function usage(info, literal) {
  const before = info.code.slice(0, literal.start), after = info.code.slice(literal.end);
  if (/\bimport\s*\(\s*$/u.test(before)) return { kind: 'dynamic', names: ALL };
  if (/\bnew\s+URL\(\s*$/u.test(before) && /^\s*,\s*import\.meta\.url\s*\)/u.test(after)) return { kind: 'url', names: [] };
  if (/\bimport\.meta\.dirname\s*,\s*$/u.test(before)) return { kind: 'path', names: [] };
  if (/\bimport\s*$/u.test(before)) return { kind: 'static', names: [] };
  const clause = /\b(?:import|export)\s*(\{[^}]*\}|\*(?:\s*as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+))?)\s*from\s*$/u.exec(before)?.[1];
  if (!clause) return null;
  if (clause.includes('*')) return { kind: 'static', names: ALL };
  const names = [];
  for (const part of /\{([^}]*)\}/u.exec(clause)?.[1].split(',').map(value => value.trim()).filter(Boolean) ?? []) {
    const row = /^([\w$]+)(?:\s+as\s+[\w$]+)?$/u.exec(part);
    if (!row) return null;
    names.push(row[1]);
  }
  if (clause.replace(/\{[^}]*\}/u, '').replaceAll(',', '').trim()) names.push('default');
  return { kind: 'static', names };
}

/** The import specifier from `file` to a repository path. */
function specifier(file, path) {
  const relative = posix.relative(posix.dirname(file), path);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/** Choose what an importer reads instead of the shim: the leaf inside the cell, core.js for pure users, else the front door. */
function choose(box, shim, file, use) {
  const have = exportsOf(box, shim), cell = box.cell;
  const names = use.names === ALL ? [...have.keys()] : use.names;
  const lost = names.filter(name => !have.has(name));
  if (lost.length) return { refuse: `${file} imports ${lost.join(', ')}, which ${shim} does not export` };
  /** Whether a module already exports every wanted name. */
  const covers = module => { const present = exportsOf(box, module); return names.every(name => present.has(name)); };
  const leaf = cell.paths.find(([from]) => from === shim)?.[1];
  const core = cell.pureFrontDoor && box.files.has(cell.pureFrontDoor) ? cell.pureFrontDoor : null;
  if (/(?:^|\/)core(?:\/|\.js$)/u.test(file)) return core && covers(core) ? { path: core, adds: [] } : { refuse: `core file ${file} would reach past ${cell.name} core.js: ${names.filter(name => !core || !exportsOf(box, core).has(name)).join(', ')}` };
  if (core && testFile(file) && use.kind === 'static' && use.names !== ALL && names.length && covers(core)) return { path: core, adds: [] };
  if (file.startsWith(`${cell.root}/`)) return leaf && covers(leaf) ? { path: leaf, adds: [] } : { refuse: `${file} inside ${cell.name} needs names its own ${shim} leaf lacks` };
  const door = cell.frontDoor, present = exportsOf(box, door), adds = [];
  for (const name of names.filter(value => !present.has(value))) {
    const row = have.get(name);
    adds.push({ file: door, name, line: `export { ${row.name === name ? name : `${row.name} as ${name}`} } from ${JSON.stringify(specifier(door, row.module))};` });
  }
  return { path: door, adds };
}

/** Plan the edit that repoints each importer of one shim, and list the importers that must stay on it, with why. */
function planShim(box, shim, hits) {
  const edits = [], held = [];
  for (const { file, source, info, literal, comment } of hits) {
    const use = comment ? { kind: 'input', names: [] } : source[literal.start] === '`' ? null : usage(info, literal);
    if (!use) { held.push(`${file}: unrecognized reference "${literal.text}"`); continue; }
    const choice = choose(box, shim, file, use);
    if (choice.refuse || choice.path === file) { held.push(choice.refuse ?? `${file} would import itself`); continue; }
    edits.push(comment ? { file, ...comment(choice.path), adds: choice.adds }
      : { file, start: literal.start + 1, end: literal.end - 1, text: specifier(file, choice.path), from: literal.text, adds: choice.adds });
  }
  return { edits, held };
}

/** Find the declared-input tokens in a header comment that name one of the shims. */
function inputTokens(source, range, shims) {
  const body = source.slice(range.start, range.end), rows = [];
  if (!body.includes('@pullboard-test-input')) return rows;
  const tokens = [...body.matchAll(/(\s+)(\S+)/gu)];
  for (const row of tokens) {
    if (!shims.has(row[2])) continue;
    const start = range.start + row.index + row[1].length;
    rows.push({ shim: row[2], start, end: start + row[2].length, lead: row[1].length, tokens: tokens.map(token => token[2]) });
  }
  return rows;
}

/** Group every reference to the shims by shim, from the checkout bytes the inventory read. */
function hitsByShim(box, shims) {
  const hits = new Map(shims.map(shim => [shim, []])), names = new Set(shims);
  for (const [file, bytes] of box.files) {
    if (!/\.[cm]?js$/u.test(file) || !shims.some(shim => bytes.includes(posix.basename(shim)))) continue;
    const source = bytes.toString('utf8'), info = scan(source);
    for (const literal of info.strings) {
      const target = literal.text.startsWith('.') ? resolveSpec(box, file, literal.text) : null;
      if (target && names.has(target)) hits.get(target).push({ file, source, info, literal });
    }
    for (const range of info.comments) for (const row of inputTokens(source, range, names)) {
      hits.get(row.shim).push({ file, source, comment: path => {
        const duplicate = row.tokens.filter(token => token === path).length > 0;
        return duplicate ? { start: row.start - row.lead, end: row.end, text: '', from: row.shim } : { start: row.start, end: row.end, text: path, from: row.shim };
      } });
    }
  }
  return hits;
}

/** Apply the surviving edits and door additions to the original bytes, returning each changed file's new source. */
function materialize(box, plans, excluded) {
  const byFile = new Map(), adds = new Map();
  for (const plan of plans.values()) for (const edit of plan.edits) if (!excluded.has(edit)) {
    byFile.set(edit.file, [...byFile.get(edit.file) ?? [], edit]);
    for (const add of edit.adds) adds.set(add.file, new Map([...adds.get(add.file) ?? [], [add.name, add.line]]));
  }
  const out = new Map();
  for (const file of new Set([...byFile.keys(), ...adds.keys()])) {
    let source = box.files.get(file).toString('utf8');
    for (const edit of (byFile.get(file) ?? []).sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    if (adds.has(file)) source = `${source.endsWith('\n') ? source : `${source}\n`}${[...adds.get(file).values()].join('\n')}\n`;
    out.set(file, source);
  }
  return out;
}

/** Write the materialized files, and restore the original bytes of any file touched earlier but no longer edited. */
function applyToDisk(box, out, touched) {
  for (const file of out.keys()) touched.add(file);
  for (const file of touched) writeFileSync(join(box.root, file), out.get(file) ?? box.files.get(file));
}

/** Every strict upward-cut problem across all cells, keyed so a repointed path still names the same edge. */
function strictProblems(box, inventory) {
  const rows = new Map();
  for (const { name } of box.plan.cells) {
    for (const problem of checkCuts(box.root, box.plan, name, { allLaterCells: true, temporaryExceptions: false, inventory })) {
      const found = /^(\S+) still imports later (\S+): (\S+) -> /u.exec(problem);
      rows.set(found ? `${found[1]}|${found[2]}|${found[3]}` : `${name}|${problem}`, problem);
    }
  }
  return rows;
}

/** Remove a cell's shims in memory-planned, audit-checked steps; returns what moved, what went, what stayed and why. */
export function removeShims(root, plan, name, { parsers, lane = 'core' } = {}) {
  if (typeof parsers?.importsIn !== 'function' || typeof parsers?.commonJsIn !== 'function') throw new TypeError('shim removal needs explicit module parser operations');
  const cell = plan.cells.find(row => row.name === name);
  if (!cell) throw new Refused('CELLS_PLAN_CELL', `no cell ${name} in the plan; use a name from bin/cells-plan.json`);
  const inventory = cellInventory(root, parsers);
  const config = inventory.files.has('package.json') ? JSON.parse(inventory.files.get('package.json').toString('utf8')) : {};
  const box = { root, plan, cell, files: inventory.files, imports: config.imports };
  const kept = new Map(), absent = cell.reexports.filter(shim => !existsSync(join(root, shim)));
  const live = cell.reexports.filter(shim => !absent.includes(shim));
  for (const shim of live) {
    const code = box.files.get(shim)?.toString('utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '').replace(/\s/gu, '');
    if (!PURE_SHIM.test(code ?? '')) kept.set(shim, `${shim} still holds code, not only re-exports`);
  }
  const candidates = live.filter(shim => !kept.has(shim)), plans = new Map(), hits = hitsByShim(box, candidates);
  for (const shim of candidates) plans.set(shim, planShim(box, shim, hits.get(shim)));
  const before = strictProblems(box, inventory), touched = new Set(), excluded = new Set(), owner = ownerFor(plan, readPathMap(root));
  let after = inventory;
  try {
    for (;;) {
      applyToDisk(box, materialize(box, plans, excluded), touched);
      after = cellInventory(root, parsers);
      const fresh = [...strictProblems(box, after)].filter(([key]) => !before.has(key));
      if (!fresh.length) break;
      const blamed = [];
      for (const [key, problem] of fresh) {
        for (const made of plans.values()) for (const edit of made.edits) if (!excluded.has(edit) && owner(edit.file) === key.split('|')[0]) {
          blamed.push(edit);
          made.held.push(`${edit.file}: removal would expose an upward cut: ${problem}`);
        }
      }
      if (!blamed.length) throw new Refused('CELLS_SHIMS_EXPOSED', `repointing exposed an upward cut no shim edit explains: ${fresh.map(row => row[1]).join('; ')}`);
      for (const edit of blamed) excluded.add(edit);
    }
  } catch (error) {
    applyToDisk(box, new Map(), touched);
    throw error;
  }
  const deleted = [];
  for (const shim of live) {
    if (kept.has(shim)) continue;
    const users = [...after.edges].filter(([, rows]) => rows.some(row => row.target === shim)).map(([file]) => file);
    const held = plans.get(shim).held;
    if (held.length || users.length) {
      const why = held.length ? held : [`still imported by ${users.slice(0, 3).join(', ')}${users.length > 3 ? ` +${users.length - 3} more` : ''}`];
      kept.set(shim, `${why.slice(0, 3).join('; ')}${why.length > 3 ? `; +${why.length - 3} more` : ''}`);
      continue;
    }
    if (tryGit(root, ['rm', '-q', '-f', '--', shim]).status !== 0) rmSync(join(root, shim), { force: true });
    deleted.push(shim);
  }
  const rewritten = [];
  for (const [shim, made] of plans) for (const edit of made.edits) if (!excluded.has(edit)) rewritten.push({ shim, file: edit.file, from: edit.from, to: edit.text || '(removed duplicate)' });
  const settings = loadConfig(root);
  const outside = [...new Set(rewritten.map(row => row.file))].filter(file => laneOf(settings, file) !== lane).sort();
  const reexports = cell.reexports.filter(shim => !deleted.includes(shim) && !absent.includes(shim));
  const next = { ...plan, cells: plan.cells.map(row => row.name === name ? { ...row, reexports } : row) };
  return { plan: next, changed: deleted.length > 0 || absent.length > 0, rewritten, deleted, absent, kept: [...kept], outside };
}

/** The lines the command prints: each repoint, deletion, kept shim with its reason, and the importers outside the lane. */
export function shimReport(result, lane = 'core') {
  const lines = result.rewritten.map(row => `repointed ${row.file}: ${row.from} -> ${row.to} (${row.shim})`);
  for (const shim of result.absent) lines.push(`dropped ${shim} from the plan: it no longer exists`);
  for (const shim of result.deleted) lines.push(`deleted ${shim}`);
  for (const [shim, reason] of result.kept) lines.push(`kept ${shim}: ${reason}`);
  for (const file of result.outside) lines.push(`outside the ${lane} lane, attach: ${file}`);
  lines.push(`${result.deleted.length} deleted, ${result.kept.length} kept, ${result.rewritten.length} repointed`);
  return lines;
}
