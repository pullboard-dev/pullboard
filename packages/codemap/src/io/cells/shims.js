/** Remove one cell's re-export shims: repoint every importer to the cell front door, then delete what nothing imports [C7,D3]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { posix } from 'node:path';
import { Script } from 'node:vm';
import {
  cellInventory,
  updateCellInventory,
} from '../../../index.js';
import {
  importCuts,
  readPathMap,
} from '../../../index.js';
import { repositoryImport } from '../../../index.js';
import { testFile } from '../../../index.js';
import { loadConfig } from '../../../../config/index.js';
import { tryGit } from '../../../../git/index.js';
import { lex } from '../../../../kernel/index.js';
import { laneOf } from '../../../../seats/index.js';
import { outOfLane } from '../../../../seats/index.js';
import { runnerWorkerFiles } from '../../../index.js';
import { moveDeclarationFiles } from '../../../index.js';
import { Refused } from '../../../../kernel/index.js';
import {
  checkCuts,
  entryPlacementProblems,
  retiredProblems,
} from './plan/cuts.js';
import { ownerFor } from './plan/cuts.js';
import { mkdtempSync } from 'node:fs';
import { scratchBase } from '../../../../kernel/light.js';

/** Marks a use that takes the shim's whole namespace, so every name it exports must stay reachable. */
const ALL = Symbol('all');
/** Reference kinds that name a file rather than import bindings, so they go to the exact moved file, never a front door. */
const BYTES = new Set(['url', 'path', 'input', 'doc']);
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
  if (!seen.size && box.exportCache?.has(file)) return box.exportCache.get(file);
  const names = new Map(), bytes = box.files.get(file);
  if (!bytes || seen.has(file)) return names;
  if (!seen.size) box.exportCache?.set(file, names);
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

/** The module and local name that finally define one export, following re-export chains, or null. */
function origin(box, module, name, depth = 0) {
  const row = exportsOf(box, module).get(name);
  if (!row || depth > 64) return null;
  return row.module === module ? `${module}#${row.name}` : origin(box, row.module, row.name, depth + 1);
}

/** What an importer takes at one literal: its kind and binding names (or ALL), or null when the site is not understood. */
function usage(info, literal) {
  const before = info.code.slice(0, literal.start), after = info.code.slice(literal.end);
  if (/\bimport\s*\(\s*$/u.test(before)) return { kind: 'dynamic', names: ALL };
  // A module URL handed on as .href is imported by a child or loader, so it keeps import semantics, never a byte read.
  if (/\bnew\s+URL\(\s*$/u.test(before) && /^\s*,\s*import\.meta\.url\s*\)\s*\.\s*href\b/u.test(after)) return { kind: 'dynamic', names: ALL };
  if (/\bnew\s+URL\(\s*$/u.test(before) && /^\s*,\s*import\.meta\.url\s*\)/u.test(after)) return { kind: 'url', names: [] };
  if (/\bpathToFileURL\(\s*(?:join|resolve)\(\s*import\.meta\.dirname\s*,\s*$/u.test(before)) return { kind: 'dynamic', names: ALL };
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

/** Where an importer sits that must read the pure core.js: a core file, or a file on the runner-worker or move-registry closure. */
function pureReason(box, file) {
  if (/(?:^|\/)core(?:\/|\.js$)/u.test(file)) return 'core file';
  if (box.runner.files?.has(file)) return 'runner-worker closure file';
  if (box.move.files?.has(file)) return 'move-registry closure file';
  return null;
}

/**
 * Choose what an importer reads instead of the shim. A file read, resolved path, declared input or doc citation names the
 * exact moved file; a core or closure file reads core.js and is refused by binding name when core.js lacks one; a file
 * inside the cell reads its own leaf; a test whose names core.js covers reads core.js; everything else reads the front door.
 */
function choose(box, shim, file, use) {
  const have = exportsOf(box, shim), cell = box.cell;
  const leaf = cell.paths.find(([from]) => from === shim)?.[1];
  if (BYTES.has(use.kind)) return leaf && box.files.has(leaf) ? { path: leaf, adds: [] } : { refuse: `${file} reads ${shim}, whose moved file ${leaf} is missing` };
  const names = use.names === ALL ? [...have.keys()] : use.names;
  const lost = names.filter(name => !have.has(name));
  if (lost.length) return { refuse: `${file} imports ${lost.join(', ')}, which ${shim} does not export` };
  /** Whether a module already exports every wanted name. */
  // A target covers a use only when each name resolves to the same definition the shim gives it: a door can bind one
  // name to a different body than the shim does (src/board.js gives ensureCoordinator the write-store one).
  const same = (module, name) => origin(box, module, name) === origin(box, shim, name);
  // A namespace (import * as, import(), a module URL) also sees every key the target exports, so it needs no extra one.
  const extra = module => use.names === ALL ? [...exportsOf(box, module).keys()].filter(name => !have.has(name)) : [];
  const covers = module => { const present = exportsOf(box, module); return names.every(name => present.has(name) && same(module, name)) && !extra(module).length; };
  const core = cell.pureFrontDoor && box.files.has(cell.pureFrontDoor) ? cell.pureFrontDoor : null;
  const pure = pureReason(box, file);
  if (pure) {
    if (core && covers(core)) return { path: core, adds: [] };
    const missing = names.filter(name => !core || !exportsOf(box, core).has(name) || !same(core, name));
    const named = missing.length > 8 ? `${missing.slice(0, 8).join(', ')} +${missing.length - 8} more` : missing.join(', ');
    return { refuse: `${pure} ${file} would reach past ${cell.name} core.js, which lacks ${named || 'a pure front door'}` };
  }
  if (core && testFile(file) && use.kind === 'static' && use.names !== ALL && names.length && covers(core)) return { path: core, adds: [] };
  if (file.startsWith(`${cell.root}/`)) return leaf && covers(leaf) ? { path: leaf, adds: [] } : { refuse: `${file} inside ${cell.name} needs names its own ${shim} leaf lacks` };
  const door = cell.frontDoor, present = exportsOf(box, door), adds = [];
  const differ = names.filter(name => present.has(name) && !same(door, name));
  if (differ.length) return { refuse: `${file} imports ${differ.join(', ')} from ${shim}, which ${door} binds to a different definition` };
  const more = extra(door);
  if (more.length) return { refuse: `${file} takes the whole ${shim} namespace, and ${door} also exports ${more.slice(0, 8).join(', ')}${more.length > 8 ? ` +${more.length - 8} more` : ''}` };
  for (const name of names.filter(value => !present.has(value))) {
    const row = have.get(name);
    adds.push({ file: door, name, line: `export { ${row.name === name ? name : `${row.name} as ${name}`} } from ${JSON.stringify(specifier(door, row.module))};` });
  }
  return { path: door, adds };
}

/**
 * Plan the edit that repoints each importer of one shim, and list the importers that must stay on it, with why. A file
 * outside the lane is never edited: it holds the shim until a removal in its own lane repoints it.
 */
function planShim(box, shim, hits) {
  const edits = [], held = [], cited = [];
  for (const { file, source, info, literal, comment, doc } of hits) {
    if (outOfLane(box.settings, box.lane, [file]).length || file === 'SPEC.md') {
      const where = `${file} (${laneOf(box.settings, file)} lane)`;
      if (doc) cited.push(where);
      else if (!held.includes(`imported by ${where}`)) held.push(`imported by ${where}`);
      continue;
    }
    const use = doc ? { kind: 'doc', names: [] } : comment ? { kind: 'input', names: [] } : source[literal.start] === '`' ? null : usage(info, literal);
    if (!use) { held.push(`${file}: unrecognized reference "${literal.text}"`); continue; }
    const choice = choose(box, shim, file, use);
    if (choice.refuse || choice.path === file) { held.push(choice.refuse ?? `${file} would import itself`); continue; }
    const foreign = choice.adds.filter(add => outOfLane(box.settings, box.lane, [add.file]).length);
    if (foreign.length) { held.push(`${file} needs ${foreign.map(add => add.name).join(', ')} added to ${foreign[0].file} (${laneOf(box.settings, foreign[0].file)} lane)`); continue; }
    edits.push(doc ? { file, start: doc.start, end: doc.end, text: choice.path, from: shim, adds: [] }
      : comment ? { file, ...comment(choice.path), adds: choice.adds }
        : { file, start: literal.start + 1, end: literal.end - 1, text: specifier(file, choice.path), from: literal.text, adds: choice.adds,
          namespace: use.names === ALL ? { target: choice.path, names: new Set(exportsOf(box, shim).keys()) } : null });
  }
  return { edits, held, cited: [...new Set(cited)] };
}

/**
 * Second pass, after the cut and closure checks settle: a namespace importer sees the target's final surface, so any export another
 * planned edit adds to that target and the shim lacks holds it. Holding one edit drops its additions, so repeat until stable.
 */
function composeNamespaces(plans, excluded) {
  let held = 0;
  for (let changed = true; changed;) {
    changed = false;
    const added = new Map();
    for (const made of plans.values()) for (const edit of made.edits) if (!excluded.has(edit)) for (const add of edit.adds) added.set(add.file, new Set([...added.get(add.file) ?? [], add.name]));
    for (const made of plans.values()) for (const edit of made.edits) {
      if (!edit.namespace || excluded.has(edit)) continue;
      const wider = [...added.get(edit.namespace.target) ?? []].filter(name => !edit.namespace.names.has(name));
      if (!wider.length) continue;
      excluded.add(edit);
      made.held.push(`${edit.file} takes a whole namespace, and this run adds ${wider.join(', ')} to ${edit.namespace.target}`);
      changed = true;
      held += 1;
    }
  }
  return held;
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

/** A whole-path citation of a shim in prose: not part of a longer path on either side. */
function citation(shim) {
  const escaped = shim.replace(/[.*+?^$()|[\]\\{}]/gu, '\\$&');
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w/-]|\\.\\w)`, 'gu');
}

/** Group every reference to the shims by shim, from the checkout bytes the inventory read. */
function hitsByShim(box, shims) {
  const hits = new Map(shims.map(shim => [shim, []])), names = new Set(shims);
  for (const [file, bytes] of box.files) {
    if (!shims.some(shim => bytes.includes(posix.basename(shim)))) continue;
    if (file.endsWith('.md')) {
      const text = bytes.toString('utf8');
      for (const shim of shims) for (const match of text.matchAll(citation(shim))) hits.get(shim).push({ file, doc: { start: match.index, end: match.index + shim.length } });
      continue;
    }
    if (!/\.[cm]?js$/u.test(file)) continue;
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

/** A string token that is a whole module path: no whitespace, a module extension, nothing after the path. */
const PATH_TOKEN = /^[^\s'"`]+\.[cm]?js$/u;
/** Code just before a literal that hands it to a module or path call: import(), require(), new URL() or path.join(). */
const PATH_ARGUMENT = /(?<![\w$.])(?:(?:import|require)\s*|new\s+URL\s*|path\s*\.\s*join\s*)\(\s*(?:[^()'"`]*,\s*)?$/u;
const STATIC_IMPORT = /(?:^|[;\n{}])\s*(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?$/u;

/**
 * Whether one path-shaped string names `path`: ./ or ../ relative, absolute, a file: URL, a template root such as
 * `${ROOT}/src/x.js`, or a bare repository path handed to a path call. A longer repository path that merely ends the
 * same way, like ./packages/a/src/x.js, is another module.
 */
function pathToken(token, path, argument) {
  if (!PATH_TOKEN.test(token) || !token.endsWith(path)) return false;
  const fileUrl = token.startsWith('file:');
  const prefix = token.slice(0, -path.length).replace(/^file:/u, '');
  if (prefix && !prefix.endsWith('/')) return false;
  // A lone leading slash is a root-relative URL a server answers, like /relay/x.js; an absolute file path has a root before it.
  return prefix ? /^(?:\.{1,2}\/)+$/u.test(prefix) || (prefix.startsWith('/') && (prefix !== '/' || fileUrl)) || /^\$\{[^}]*\}\//u.test(prefix) : fileUrl || argument;
}

/**
 * Whether a string literal names `path` as a module: the whole literal is a path, or a quoted string inside it is, as in a
 * generated child script's `import ... from './src/x.js'`. A sentence that mentions a path is prose and never counts.
 */
function namesPath(text, path, argument) {
  if (pathToken(text, path, argument)) return text.lastIndexOf(path);
  // Compile only source-shaped embedded scripts; this never runs the string or its imports.
  let script = false;
  if (text.length <= 1024 * 1024 && /\b(?:const|let|var|import|export|require|return|function|class|new)\b|[=;(){}]/u.test(text)) {
    try { new Script(text); script = true; } catch { /* Static module syntax is handled below. */ }
  }
  const nestedStrings = new Set(lex(text).strings.map(row => row.start));
  for (const quoted of text.matchAll(/(['"])([^'"\s]*)\1/gu)) {
    const before = text.slice(Math.max(0, quoted.index - 200), quoted.index);
    if (nestedStrings.has(quoted.index) && (script || PATH_ARGUMENT.test(before) || STATIC_IMPORT.test(before)) && pathToken(quoted[2], path, true)) return quoted.index + 1 + quoted[2].lastIndexOf(path);
  }
  return -1;
}

/**
 * Every place a test source names one of `paths` in a string literal (see namesPath): a generated child script importing
 * `./src/x.js`, `/abs/root/src/x.js` or `file:///abs/root/src/x.js` is invisible to import checks, so deleting a named
 * path turns main red. A literal that `resolve` maps to the path is an ordinary import the repoint already handles;
 * comments and prose sentences never hold a path.
 */
export function scriptMentions(files, paths, resolve = () => null) {
  const rows = [], wanted = [...new Set(paths)];
  for (const [file, bytes] of files) {
    if (!testFile(file) || !/\.[cm]?js$/u.test(file)) continue;
    const source = bytes.toString('utf8');
    if (!wanted.some(path => source.includes(path))) continue;
    const info = lex(source);
    for (const literal of info.strings) for (const path of wanted) {
      if (!literal.text.includes(path) || resolve(file, literal.text) === path) continue;
      const at = namesPath(literal.text, path, PATH_ARGUMENT.test(info.code.slice(Math.max(0, literal.start - 200), literal.start)));
      if (at < 0) continue;
      rows.push({ file, line: source.slice(0, literal.start + 1 + at).split('\n').length, path });
    }
  }
  return rows;
}

/** Apply the surviving edits and door additions to the original bytes, returning each changed file's new source. */
function materialize(box, plans, excluded) {
  const out = materializeAll(box, plans, excluded);
  const foreign = [...out.keys()].filter(file => outOfLane(box.settings, box.lane, [file]).length);
  if (foreign.length) throw new Refused('CELLS_SHIMS_LANE', `shim removal in the ${box.lane} lane would write ${foreign.join(', ')}, outside it`);
  return out;
}

/** Every changed file's new source, before the lane guard. */
function materializeAll(box, plans, excluded) {
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

/** The entries whose closures ship to a runner: the worker and each package provider the controller composes. */
function runnerEntries(box, parsers) {
  const controller = box.files.get('apps/runner/src/io/controller.js')?.toString('utf8');
  const providers = controller ? parsers.importsIn([controller])[0].filter(text => text.startsWith('../packages/')).map(text => text.slice(3)) : [];
  return ['apps/runner/src/io/scripts/worker.js', ...new Set(providers)];
}

/** Every file the runner closures reach, or the bound or resolution problem that stops them. */
function runnerClosure(root, entries, parsers, inventoryFiles) {
  const files = new Set();
  try { for (const entry of entries) for (const file of runnerWorkerFiles(root, { ...parsers, files: inventoryFiles.keys() }, entry)) files.add(file); }
  catch (error) { return { files: null, problem: error.message }; }
  return { files, problem: null };
}

/** Every file the move declarations reach, or the problem: an unbounded closure or a process launcher inside it. */
function moveClosure(root, parsers, files) {
  let reached;
  try { reached = moveDeclarationFiles(root, { ...parsers, files: files.keys() }); }
  catch (error) { return { files: null, problem: error.message }; }
  const list = [...reached].sort(), imports = parsers.importsIn(list.map(file => files.get(file).toString('utf8')));
  const launchers = list.filter((_file, index) => imports[index].includes('node:child_process'));
  return { files: reached, problem: launchers.length ? `process launcher ${launchers.join(', ')} in the move-registry closure` : null };
}

/** Every strict upward-cut problem across all cells, keyed so a repointed path still names the same edge. */
function strictProblems(box, inventory) {
  const rows = new Map();
  // The path map and process entries do not vary by cell: read and parse them once per sweep (#2232).
  const map = readPathMap(box.root), shared = { map, retired: retiredProblems(box.root, box.plan, inventory), groups: importCuts(box.plan), entries: entryPlacementProblems(box.root, box.plan, inventory.files, map) };
  for (const { name } of box.plan.cells) {
    for (const problem of checkCuts(box.root, box.plan, name, { allLaterCells: true, temporaryExceptions: false, inventory, shared })) {
      const found = /^(\S+) still imports later (\S+): (\S+) -> /u.exec(problem);
      rows.set(found ? `${found[1]}|${found[2]}|${found[3]}` : `${name}|${problem}`, problem);
    }
  }
  return rows;
}

/** Remove a cell's shims in memory-planned, audit-checked steps; returns what moved, what went, what stayed and why. */
export function removeShims(root, plan, name, { parsers, lane = 'core', planFiles = [] } = {}) {
  if (typeof parsers?.importsIn !== 'function' || typeof parsers?.commonJsIn !== 'function') throw new TypeError('shim removal needs explicit module parser operations');
  const cell = plan.cells.find(row => row.name === name);
  if (!cell) throw new Refused('CELLS_PLAN_CELL', `no cell ${name} in the plan; use a name from packages/codemap/data/plan/cells.json`);
  const inventory = cellInventory(root, parsers);
  const config = inventory.files.has('package.json') ? JSON.parse(inventory.files.get('package.json').toString('utf8')) : {};
  const settings = loadConfig(root);
  if (!Object.hasOwn(settings.lanes ?? {}, lane)) throw new Refused('CELLS_PLAN_MODE', `no lane ${lane} in pullboard.json; use one of ${Object.keys(settings.lanes ?? {}).join(', ')}`);
  const box = { root, plan, cell, files: inventory.files, imports: config.imports, settings, lane, exportCache: new Map() };
  // A deletion or a dropped row rewrites these plan files, so a lane that does not own every one of them changes neither.
  const foreignPlan = planFiles.filter(file => outOfLane(settings, lane, [file]).length).map(file => `${file} (${laneOf(settings, file)} lane)`);
  const entries = runnerEntries(box, parsers);
  box.runner = runnerClosure(root, entries, parsers, inventory.files);
  box.move = moveClosure(root, parsers, inventory.files);
  const kept = new Map(), absent = foreignPlan.length ? [] : cell.reexports.filter(shim => !existsSync(join(root, shim)));
  const live = cell.reexports.filter(shim => !absent.includes(shim) && existsSync(join(root, shim)));
  for (const shim of cell.reexports.filter(row => !existsSync(join(root, row)))) if (!absent.includes(shim)) kept.set(shim, `${shim} no longer exists; dropping its row rewrites ${foreignPlan.join(', ')}, outside the ${lane} lane`);
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
      after = updateCellInventory(root, parsers, inventory, touched);
      const fresh = [...strictProblems(box, after)].filter(([key]) => !before.has(key));
      const blamed = [];
      /** Hold every edit in a file of a closure that the repoint broke, naming why. */
      const closureBlame = (closure, now, what) => {
        if (closure.problem || !now.problem) return;
        const count = blamed.length;
        for (const made of plans.values()) for (const edit of made.edits) if (!excluded.has(edit) && !blamed.includes(edit) && closure.files.has(edit.file)) {
          blamed.push(edit);
          made.held.push(`repointing ${edit.file} would break the ${what}: ${now.problem}`);
        }
        if (blamed.length === count) throw new Refused('CELLS_SHIMS_EXPOSED', `repointing broke the ${what} and no shim edit explains it: ${now.problem}`);
      };
      closureBlame(box.runner, runnerClosure(root, entries, parsers, after.files), 'runner-worker closure');
      closureBlame(box.move, moveClosure(root, parsers, after.files), 'move-registry closure');
      if (!fresh.length && !blamed.length) break;
      for (const [key, problem] of fresh) {
        for (const made of plans.values()) for (const edit of made.edits) if (!excluded.has(edit) && owner(edit.file) === key.split('|')[0]) {
          blamed.push(edit);
          made.held.push(`${edit.file}: removal would expose an upward cut: ${problem}`);
        }
      }
      if (fresh.length && !blamed.length) throw new Refused('CELLS_SHIMS_EXPOSED', `repointing exposed an upward cut no shim edit explains: ${fresh.map(row => row[1]).join('; ')}`);
      for (const edit of blamed) excluded.add(edit);
    }
    // Only now is each door's final surface known; holding a namespace edit just restores its shim import.
    if (composeNamespaces(plans, excluded)) {
      applyToDisk(box, materialize(box, plans, excluded), touched);
      after = cellInventory(root, parsers);
    }
  } catch (error) {
    applyToDisk(box, new Map(), touched);
    throw error;
  }
  const deleted = [], named = scriptMentions(after.files, live, (file, text) => text.startsWith('.') ? resolveSpec(box, file, text) : null);
  for (const shim of live) {
    if (kept.has(shim)) continue;
    const users = [...after.edges].filter(([, rows]) => rows.some(row => row.target === shim)).map(([file]) => file);
    const held = plans.get(shim).held, why = [];
    // Ownership first: a shim this lane may not delete is reported as such before the importers that also hold it.
    if (outOfLane(settings, lane, [shim]).length) why.push(`${shim} is owned by the ${laneOf(settings, shim)} lane; a removal there deletes it`);
    if (foreignPlan.length) why.push(`deleting ${shim} rewrites ${foreignPlan.join(', ')}, outside the ${lane} lane`);
    why.push(...named.filter(row => row.path === shim).map(row => `${row.file}:${row.line} names ${shim} inside a string; point it at the moved file or front door`));
    why.push(...held.filter(row => !row.startsWith('imported by ')), ...held.filter(row => row.startsWith('imported by ')));
    if (users.length) why.push(`still imported by ${users.join(', ')}`);
    if (why.length) { kept.set(shim, why.join('; ')); continue; }
    deleted.push(shim);
  }
  // One git rm for every deleted shim, not one process each; a refusal falls back to plain file removal (#2232).
  if (deleted.length && tryGit(root, ['rm', '-q', '-f', '--', ...deleted]).status !== 0) {
    for (const shim of deleted) if (tryGit(root, ['rm', '-q', '-f', '--', shim]).status !== 0) rmSync(join(root, shim), { force: true });
  }
  const rewritten = [];
  for (const [shim, made] of plans) for (const edit of made.edits) if (!excluded.has(edit)) rewritten.push({ shim, file: edit.file, from: edit.from, to: edit.text || '(removed duplicate)' });
  const cited = [...plans].flatMap(([shim, made]) => made.cited.map(file => `${file} cites ${shim}; not rewritten outside the ${lane} lane`));
  const reexports = cell.reexports.filter(shim => !deleted.includes(shim) && !absent.includes(shim));
  const next = { ...plan, cells: plan.cells.map(row => row.name === name ? { ...row, reexports } : row) };
  const keptDetails = [...kept].map(([shim, reason]) => ({ shim, reason, importers: [...new Set([
    ...[...after.edges].filter(([, rows]) => rows.some(row => row.target === shim)).map(([file]) => file),
    ...named.filter(row => row.path === shim).map(row => row.file),
  ])].sort() }));
  return { plan: next, changed: deleted.length > 0 || absent.length > 0, rewritten, deleted, absent, kept: [...kept], keptDetails, cited };
}

/** Make complete, reviewable board text for each shim that could not be removed. */
export function shimHandoff(result, cell, item) {
  if (!result.keptDetails?.length) return null;
  const rows = result.keptDetails.map(({ shim, reason, importers }) => `- ${shim}: ${reason}; importers: ${importers.length ? importers.join(', ') : '(none found)'}`);
  const fact = `Cells ${cell} kept shims:\n${rows.join('\n')}`;
  const title = `Cells cut: remove remaining ${cell} shim importers`;
  const criterion = `After the ${cell} shim removal, resolve these remaining edges and remove the kept shims where safe:\n${rows.join('\n')}`;
  return { fact, title, criterion, after: item ?? null };
}

/** Obtain board identity and the one live claim before any optional board write. */
function claimedItem(root, lane, env) {
  const read = args => {
    const run = spawnSync('pullboard', [...args, '--json'], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) throw new Refused('CELLS_PLAN_FILE', `pullboard ${args[0]} failed: ${run.stderr?.trim() || run.error?.message || run.status}`);
    try { return JSON.parse(run.stdout); } catch { throw new Refused('CELLS_PLAN_FILE', `pullboard ${args[0]} did not return JSON`); }
  };
  const me = read(['whoami']);
  const claims = (read(['list', lane, '--all']).items ?? []).filter(row => row.item_owner === me.id && row.item_status === 'claimed' && Date.parse(row.item_lease_until) > Date.now());
  if (claims.length !== 1) throw new Refused('CELLS_PLAN_FILE', 'a single live claimed removal item is required for --file-cut');
  return claims[0].item_id;
}

/** Persist the handoff outside the checkout and optionally record it through the normal board CLI. */
export function writeShimHandoff(root, result, cell, { lane = 'core', directory, fileCut = false, env = process.env } = {}) {
  if (!result.keptDetails?.length) return null;
  let item;
  if (fileCut) item = claimedItem(root, lane, env);
  else try { item = claimedItem(root, lane, env); } catch { item = null; } // An unjoined dry run still produces a draft.
  const handoff = shimHandoff(result, cell, item);
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const add = ['add', lane, handoff.title, '--criterion', handoff.criterion, '--after', String(item ?? '<removal item id>'), '--force-size', 'one cut must enumerate every remaining shim importer'];
  const command = `pullboard ${add.map(quote).join(' ')}`;
  const out = directory ?? mkdtempSync(join(scratchBase(), 'pullboard-shim-handoff-'));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'fact.txt'), handoff.fact + '\n');
  writeFileSync(join(out, 'cut-item.txt'), `Title: ${handoff.title}\nCriterion: ${handoff.criterion}\n--after ${item ?? '<removal item id>'}\n${command}\n`);
  if (fileCut) {
    const short = `Please file after #${item}: ${handoff.title}. `;
    const complete = `${short}${handoff.criterion}`;
    const request = Array.from(complete).length <= 400 ? complete : `${short}Full criterion and every importer are in the kept-shim fact on #${item}.`;
    for (const args of [['fact', String(item), 'note', handoff.fact], ['shout', 'coordinator', '--kind', 'question', request]]) {
      const run = spawnSync('pullboard', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      if (run.status !== 0) throw new Refused('CELLS_PLAN_FILE', `pullboard ${args[0]} failed: ${run.stderr?.trim() || run.error?.message || run.status}; handoff retained in ${out}`);
    }
  }
  return { ...handoff, command, directory: out };
}

/** The lines the command prints: each repoint, deletion, kept shim with its reason, and the citations left outside the lane. */
export function shimReport(result) {
  const lines = result.rewritten.map(row => `repointed ${row.file}: ${row.from} -> ${row.to} (${row.shim})`);
  for (const shim of result.absent) lines.push(`dropped ${shim} from the plan: it no longer exists`);
  for (const shim of result.deleted) lines.push(`deleted ${shim}`);
  for (const [shim, reason] of result.kept) lines.push(`kept ${shim}: ${reason}`);
  for (const line of result.cited) lines.push(`not rewritten: ${line}`);
  lines.push(`${result.deleted.length} deleted, ${result.kept.length} kept, ${result.rewritten.length} repointed`);
  return lines;
}
