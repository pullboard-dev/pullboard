#!/usr/bin/env node
/** Cut every re-export shim in one pass: repoint its importers to the front door it forwards to, then delete it [C7,R62]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitExecFileSync } from '../../../git/light.js';

/** A front door: a package's index.js or pure core.js, or an app's index.js. */
const DOOR = /^(?:packages\/[^/]+\/(?:index|core)\.js|apps\/[^/]+\/index\.js)$/u;
/** Keywords after which a slash opens a regular expression rather than dividing. */
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
/** Plan files list shims as data; this script rewrites their reexports itself, so a path there is no string load. */
const PLAN_FILE = /^packages\/codemap\/data\/plan(?:\.json|\/.*\.json)$/u;
/** Files whose path mentions are history, not a load or a public entry. */
const HISTORY = new Set(['CHANGELOG.md']);
/** The files the cross-cell edge ratchet reads: production sources, never tests. */
const RATCHET_SOURCE = /^(?:src|packages|apps|bin)\/.*\.[cm]?js$/u;
const RATCHET_TEST = /(?:^|\/)test\/|\.(?:test|spec)\.[cm]?js$/u;

/**
 * Blank comments and literal bodies so statements can be matched on code alone, and list each plain quoted literal.
 * Why: an embedded child script inside a template literal says `import ... from './x.js'` but is not an import.
 */
export function lexModule(source) {
  const code = source.split('');
  const bare = source.split('');
  const strings = [];
  const stack = [];
  let last = '';
  let i = 0;
  const blank = (from, to, both = false) => { for (let k = from; k < to; k++) if (code[k] !== '\n') { code[k] = ' '; if (both) bare[k] = ' '; } };
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') { const end = source.indexOf('\n', i); const stop = end < 0 ? source.length : end; blank(i, stop, true); i = stop; continue; }
    if (c === '/' && n === '*') { const end = source.indexOf('*/', i + 2); const stop = end < 0 ? source.length : end + 2; blank(i, stop, true); i = stop; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      strings.push({ start: i, end: j + 1, quote: c, text: source.slice(i + 1, j) });
      blank(i + 1, j); i = j + 1; last = 'x'; continue;
    }
    if (c === '`' || (c === '}' && stack.length && stack.at(-1) === 0)) {
      if (c === '}') stack.pop();
      let j = i + 1;
      while (j < source.length && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      if (source[j] === '$') { stack.push(0); i = j + 2; last = '('; continue; }
      i = j + 1; last = 'x'; continue;
    }
    if (c === '{' && stack.length) stack[stack.length - 1] += 1;
    if (c === '}' && stack.length) stack[stack.length - 1] -= 1;
    if (c === '/') {
      const word = /([\w$]+)\s*$/u.exec(source.slice(Math.max(0, i - 20), i))?.[1];
      const regex = !last || /[(,=:[!&|?{};+\-*%<>~^]/u.test(last) || (word && REGEX_AFTER.has(word) && /[\w$]/u.test(last));
      if (regex) {
        let j = i + 1, klass = false;
        while (j < source.length && source[j] !== '\n' && (klass || source[j] !== '/')) {
          if (source[j] === '\\') j += 1;
          else if (source[j] === '[') klass = true;
          else if (source[j] === ']') klass = false;
          j += 1;
        }
        blank(i + 1, j); i = j + 1;
        while (/[a-z]/u.test(source[i] ?? '')) i += 1;
        last = 'x'; continue;
      }
    }
    if (!/\s/u.test(c)) last = c;
    i += 1;
  }
  return { code: code.join(''), strings, bare: bare.join('') };
}

/** Resolve a relative specifier written in `file` to a repository path, or null for a bare one. */
function resolveSpec(file, text) {
  if (!text.startsWith('./') && !text.startsWith('../')) return null;
  return posix.normalize(posix.join(posix.dirname(file), text));
}

/** The specifier that reaches `path` from `file`. */
function specifier(file, path) {
  const relative = posix.relative(posix.dirname(file), path);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/** Split an import or export brace list into { imported, local } pairs, or null when a part is not understood. */
function bindings(list) {
  const rows = [];
  for (const part of list.split(',').map(value => value.trim()).filter(Boolean)) {
    const row = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/u.exec(part);
    if (!row) return null;
    rows.push({ imported: row[1], local: row[2] ?? row[1] });
  }
  return rows;
}

/**
 * Every module statement that names a literal: kind (import, export, bare, dynamic), the clause text and its span.
 * Only top-level static statements are rewritten; a dynamic import is a load by string.
 */
function statements(source, info) {
  const rows = [];
  for (const literal of info.strings) {
    // A statement's clause is short: read a window before the literal, not the whole prefix, so each file lexes in linear time.
    const from = Math.max(0, literal.start - 4000);
    const before = (from ? '\n' : '') + info.code.slice(from, literal.start);
    if (/\bimport\s*\(\s*$/u.test(before)) { rows.push({ kind: 'dynamic', literal, start: literal.start, end: literal.end, clause: '' }); continue; }
    const match = /(^|[;\n}])(\s*)(import|export)\b([^;'"]*?)\bfrom\s*$/u.exec(before)
      ?? /(^|[;\n}])(\s*)(import)()\s*$/u.exec(before);
    if (!match) continue;
    const start = from + match.index + match[1].length + match[2].length - (from ? 1 : 0);
    let end = literal.end;
    while (source[end] === ' ') end += 1;
    if (source[end] === ';') end += 1;
    const clause = match[4].trim();
    rows.push({ kind: match[4] === '' && match[3] === 'import' ? 'bare' : match[3], clause, start, end, literal });
  }
  return rows;
}

/** Load every tracked file once, with lexed modules for the scripts. */
function loadRepo(root) {
  const listed = gitExecFileSync(['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const files = new Map();
  for (const file of listed) {
    if (!existsSync(join(root, file))) continue;
    const bytes = readFileSync(join(root, file));
    if (bytes.includes(0)) continue;
    files.set(file, bytes.toString('utf8'));
  }
  const lexed = new Map();
  const lexOf = file => {
    if (!lexed.has(file)) { const source = files.get(file); lexed.set(file, source === undefined ? null : lexModule(source)); }
    return lexed.get(file);
  };
  return { root, files, lexOf, exportCache: new Map() };
}

/** Every name a module exports, mapped to the module and name one hop away that supplies it. */
function exportsOf(repo, file, seen = new Set()) {
  if (repo.exportCache.has(file)) return repo.exportCache.get(file);
  const names = new Map();
  const source = repo.files.get(file);
  if (source === undefined || seen.has(file)) return names;
  const chain = new Set(seen).add(file);
  const info = repo.lexOf(file);
  for (const row of statements(source, info)) {
    if (row.kind !== 'export') continue;
    const target = resolveSpec(file, row.literal.text);
    if (!target) continue;
    if (row.clause.startsWith('{')) for (const pair of bindings(row.clause.slice(1, -1)) ?? []) names.set(pair.local, { module: target, name: pair.imported });
    else if (/^\*\s*as\s+([\w$]+)$/u.test(row.clause)) names.set(/([\w$]+)$/u.exec(row.clause)[1], { module: file, name: '*' });
    else if (row.clause === '*') for (const [name] of exportsOf(repo, target, chain)) if (name !== 'default' && !names.has(name)) names.set(name, { module: target, name });
  }
  for (const match of info.code.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/gu)) for (const pair of bindings(match[1]) ?? []) names.set(pair.local, { module: file, name: pair.local });
  for (const match of info.code.matchAll(/\bexport\s+(?:async\s+)?(?:(?:const|let|var|class)\s+|function\s*\*?\s*)([\w$]+)/gu)) names.set(match[1], { module: file, name: match[1] });
  if (!seen.size) repo.exportCache.set(file, names);
  return names;
}

/** The module and name that finally define one export, following re-export hops. */
function origin(repo, module, name, depth = 0) {
  const row = exportsOf(repo, module).get(name);
  if (!row || depth > 64) return null;
  return row.module === module ? `${module}#${row.name}` : origin(repo, row.module, row.name, depth + 1);
}

/** Read a candidate: its export statements, each forwarding to a front door, or null when it holds anything else. */
function readShim(repo, file) {
  const source = repo.files.get(file);
  const info = repo.lexOf(file);
  const rows = statements(source, info);
  let rest = info.code;
  for (const row of [...rows].sort((a, b) => b.start - a.start)) if (row.kind !== 'dynamic') rest = rest.slice(0, row.start) + rest.slice(row.end);
  if (rest.trim() || !rows.length || rows.some(row => row.kind !== 'export')) return null;
  const named = new Map(), stars = [];
  for (const row of rows) {
    const door = resolveSpec(file, row.literal.text);
    if (!door || !DOOR.test(door) || !repo.files.has(door)) return null;
    if (row.clause === '*') stars.push(door);
    else if (row.clause.startsWith('{')) {
      const pairs = bindings(row.clause.slice(1, -1));
      if (!pairs) return null;
      for (const pair of pairs) named.set(pair.local, { door, name: pair.imported });
    } else return null;
  }
  return { file, named, stars, doors: [...new Set([...named.values()].map(row => row.door).concat(stars))] };
}

/** The package or app folder a path sits in, or null. */
function unitOf(path) {
  return /^((?:packages|apps)\/[^/]+)\//u.exec(path)?.[1] ?? null;
}

/** The lane that owns a path: the longest declared prefix wins, as pullboard's own lane rule reads it. */
function laneOf(lanes, path) {
  let owner = 'coordinator', longest = 0;
  for (const [name, lane] of Object.entries(lanes)) for (const prefix of lane.owns ?? []) if (path.startsWith(prefix) && prefix.length > longest) { owner = name; longest = prefix.length; }
  return owner;
}

/**
 * Where one imported name of a shim comes from: the door and its name. A name the shim forwards by export-star is found
 * in the one star door that exports it.
 */
function forwarded(repo, shim, name) {
  if (shim.named.has(name)) return shim.named.get(name);
  const doors = shim.stars.filter(door => exportsOf(repo, door).has(name));
  return doors.length === 1 ? { door: doors[0], name } : null;
}

/**
 * Choose the module an importer reads for one forwarded name. A file inside the door's own package reads the leaf the door
 * forwards from, never its own front door; a core file reads the pure core.js when it binds the same definition.
 */
function choose(repo, importer, { door, name }) {
  const unit = unitOf(door);
  if (unit && importer.startsWith(`${unit}/`)) {
    const hop = exportsOf(repo, door).get(name);
    if (!hop || hop.module === importer || hop.module === door || hop.name === '*') return null;
    return { module: hop.module, name: hop.name };
  }
  const core = unit && unit.startsWith('packages/') ? `${unit}/light.js` : null;
  if (core && core !== door && repo.files.has(core) && /(?:^|\/)(?:logic\/|light\.js$)/u.test(importer) && origin(repo, core, name) === origin(repo, door, name)) return { module: core, name };
  return { module: door, name };
}

/** The import or export statements for a module and its bindings, in the importer's quote style. */
function render(kind, rows, file, module, quote) {
  const spec = `${quote}${specifier(file, module)}${quote}`;
  // The style check wants one import binding per line, so each binding gets its own statement.
  return rows.map(row => `${kind} { ${row.imported === row.local ? row.imported : `${row.imported} as ${row.local}`} } from ${spec};`).join('\n');
}

/**
 * Repoint a namespace import of a one-door shim, renaming each `ns.member` to the door's real name for it. Why: a shim
 * can rename on re-export (src/board.js gives board_ensureCoordinator as ensureCoordinator), so swapping only the
 * import would change which function runs. A namespace used other than through a named member is held.
 */
function namespace(repo, file, row, shim, door) {
  const ns = /([\w$]+)$/u.exec(row.clause)[1];
  const info = repo.lexOf(file);
  const also = [];
  const uses = new RegExp(`(?<![\\w$.])${ns.replace('$', '\\$')}\\b`, 'gu');
  for (const match of info.code.matchAll(uses)) {
    if (match.index >= row.start && match.index < row.end) continue;
    const member = /^\s*\.\s*([\w$]+)/u.exec(info.code.slice(match.index + ns.length));
    if (!member) return { hold: `${file} uses the ${ns} namespace other than through a named member` };
    const source = forwarded(repo, shim, member[1]);
    if (!source || !exportsOf(repo, door).has(source.name)) return { hold: `${file} reads ${ns}.${member[1]}, which no front door behind it exports` };
    if (source.name !== member[1]) {
      const at = match.index + ns.length + member[0].length - member[1].length;
      also.push({ start: at, end: at + member[1].length, text: source.name });
    }
  }
  return { text: `${row.kind} ${row.clause} from ${row.literal.quote}${specifier(file, door)}${row.literal.quote};`, also };
}

/** Apply a file's chosen rewrites, each a statement span plus any member renames, from the last offset to the first. */
function applyRows(source, rows) {
  const spans = rows.flatMap(row => [row.span ? { ...row.span, text: row.text } : { start: row.start, end: row.end, text: row.text }, ...(row.also ?? [])]);
  for (const span of spans.sort((a, b) => b.start - a.start)) source = source.slice(0, span.start) + span.text + source.slice(span.end);
  return source;
}

/** Plan the replacement text for one statement that reads a shim, or the reason it cannot be rewritten. */
function rewrite(repo, file, row, shim) {
  const quote = row.literal.quote;
  if (row.kind === 'dynamic') {
    // A dynamic import reads the whole namespace; the one door serves it unchanged only when no name is renamed.
    const door = shim.doors.length === 1 ? shim.doors[0] : null;
    const plain = door && [...shim.named].every(([name, row2]) => row2.name === name && origin(repo, door, name) !== null);
    if (!plain || file.startsWith(`${unitOf(door)}/`)) return { hold: `${file} loads it with a dynamic import, and no single door serves the same names` };
    return { text: specifier(file, door), span: { start: row.literal.start + 1, end: row.literal.end - 1 } };
  }
  if (row.kind === 'bare') return { text: shim.doors.map(door => `import ${quote}${specifier(file, door)}${quote};`).join('\n') };
  let pairs;
  if (row.clause.startsWith('{')) pairs = bindings(row.clause.slice(1, -1));
  else if (row.kind === 'export' && row.clause === '*') {
    if (!shim.named.size) return { text: shim.stars.map(door => `export * from ${quote}${specifier(file, door)}${quote};`).join('\n') };
    if (shim.stars.length) return { hold: `${file} re-exports the whole of a mixed shim` };
    pairs = [...shim.named.keys()].map(name => ({ imported: name, local: name }));
  } else if (/^\*\s*as\s+[\w$]+$/u.test(row.clause) && !shim.named.size && shim.stars.length === 1 && !file.startsWith(`${unitOf(shim.stars[0])}/`)) {
    return { text: `${row.kind} ${row.clause} from ${quote}${specifier(file, shim.stars[0])}${quote};` };
  } else if (/^\*\s*as\s+[\w$]+$/u.test(row.clause) && shim.doors.length === 1 && !file.startsWith(`${unitOf(shim.doors[0])}/`)) {
    return namespace(repo, file, row, shim, shim.doors[0]);
  } else return { hold: `${file} takes it as ${row.clause || 'a default'}, which a front door would widen` };
  if (!pairs) return { hold: `${file} has an import list this script does not read` };
  const groups = new Map();
  for (const pair of pairs) {
    const source = forwarded(repo, shim, pair.imported);
    if (!source) return { hold: `${file} imports ${pair.imported}, which no front door behind it exports` };
    const target = choose(repo, file, source);
    if (!target) return { hold: `${file} sits inside ${unitOf(source.door)} and would import its own front door for ${pair.imported}` };
    if (!exportsOf(repo, target.module).has(target.name)) return { hold: `${target.module} does not export ${target.name}` };
    groups.set(target.module, [...groups.get(target.module) ?? [], { imported: target.name, local: pair.local }]);
  }
  return { text: [...groups].map(([module, rows]) => render(row.kind, rows, file, module, quote)).join('\n') };
}

/** The cell a path belongs to, as the cross-cell edge ratchet names it: a package's name, apps/<name>, or the root. */
function cellOf(path) {
  const match = /^((?:packages|apps)\/[^/]+)\//u.exec(path);
  return match ? match[1].replace(/^packages\//u, '') : '(root)';
}

/** The other cells one source imports, as the cross-cell ratchet counts them. */
function cellEdges(file, source) {
  const own = cellOf(file);
  const edges = new Set();
  for (const row of statements(source, lexModule(source))) {
    const target = resolveSpec(file, row.literal.text);
    if (target && cellOf(target) !== own && cellOf(target) !== '(root)') edges.add(cellOf(target));
  }
  return edges;
}

/**
 * Whether a rewritten production file stays inside the cross-cell ratchet (packages/gate/src/io/edges.js): no more undeclared
 * cells than its ceiling, and no cell-to-cell edge the ceilings do not already hold. Why: a shim under src/ hid the edge
 * from the count, so repointing can surface it; a new edge is the owner's decision, not this cut's.
 */
function withinRatchet(ratchet, file, source) {
  if (!RATCHET_SOURCE.test(file) || RATCHET_TEST.test(file)) return true;
  const from = cellOf(file);
  const edges = [...cellEdges(file, source)].filter(to => !ratchet.declared.has(`${from}->${to}`));
  const ceiling = ratchet.ceilings.files?.[file] ?? { cells: 0 };
  const known = new Set(ratchet.ceilings.cells?.[from]?.imports ?? []);
  return edges.length <= ceiling.cells && edges.every(to => from === '(root)' || known.has(to));
}

/** Whether `text` names `path` as a whole path: bare, ./ or ../ relative, or after a template or absolute root. */
function mentions(text, path) {
  for (let at = text.indexOf(path); at >= 0; at = text.indexOf(path, at + 1)) {
    const after = text.slice(at + path.length, at + path.length + 2);
    if (/^[\w/-]|^\.\w/u.test(after)) continue;
    // A quoted path used as an object key is a table entry (a recorded digest, a count), not something loaded.
    if (/^['"]\s*:/u.test(text.slice(at + path.length, at + path.length + 8))) continue;
    const before = text.slice(Math.max(0, at - 200), at);
    if (!before || /[^\w./-]$/u.test(before) || /(?:^|[^\w.-])(?:\.{1,2}\/)+$/u.test(before) || /\}\/$/u.test(before)) return true;
  }
  return false;
}

/** Find, rewrite and delete every shim; leave the ones a rule keeps, with why. */
export function cutShims(root, { write = true, frozen = [], reviewed = [] } = {}) {
  const repo = loadRepo(root);
  const pkg = JSON.parse(repo.files.get('package.json'));
  const lanes = JSON.parse(repo.files.get('pullboard.json')).lanes ?? {};
  const entries = new Set([...Object.values(typeof pkg.bin === 'string' ? { bin: pkg.bin } : pkg.bin ?? {}),
    ...JSON.stringify(pkg.exports ?? {}).match(/"\.\/[^"]+"/gu)?.map(text => text.slice(3, -1)) ?? [], pkg.main].filter(Boolean).map(path => path.replace(/^\.\//u, '')));
  const scripts = [...repo.files.keys()].filter(file => /\.m?js$/u.test(file));
  const shims = new Map();
  for (const file of scripts) {
    if (DOOR.test(file)) continue;
    const shim = readShim(repo, file);
    if (shim) shims.set(file, shim);
  }
  const kept = new Map();
  const data = new Map();
  const keep = (file, reason) => kept.set(file, [...kept.get(file) ?? [], reason]);
  // Files that live items hold during the freeze are never written: a shim one of them imports stays.
  const isFrozen = file => frozen.some(path => (path.endsWith('/') ? file.startsWith(path) : file === path));
  // The lifecycle audit names a src/ module by its identity under src/, such as 'board-escalate.js#escalate'.
  const shortNames = new Map([...shims.keys()].filter(file => file.startsWith('src/')).map(file => [file.slice(4), file]));
  for (const file of shims.keys()) {
    if (isFrozen(file)) keep(file, 'frozen: a live item holds it');
    if (entries.has(file)) keep(file, 'named in package.json bin or exports');
    if (laneOf(lanes, file) !== 'core') keep(file, `owned by the ${laneOf(lanes, file)} lane`);
  }
  const statementsOf = new Map(scripts.map(file => [file, statements(repo.files.get(file), repo.lexOf(file))]));
  const edits = new Map();
  for (const [file, rows] of statementsOf) {
    for (const row of rows) {
      const target = resolveSpec(file, row.literal.text);
      if (!target || !shims.has(target)) continue;
      const lane = laneOf(lanes, file);
      if (lane !== 'core') { keep(target, `imported by ${file} (${lane} lane)`); continue; }
      if (isFrozen(file)) { keep(target, `imported by ${file} (frozen)`); continue; }
      const plan = rewrite(repo, file, row, shims.get(target));
      if (plan.hold) { keep(target, plan.hold); continue; }
      edits.set(file, [...edits.get(file) ?? [], { ...row, shim: target, text: plan.text, span: plan.span, also: plan.also }]);
    }
  }
  // A file read by hand and found to name shim paths only as data (a policy list, a logical audit identity, an import-map key).
  const named = new Set(reviewed);
  for (const [file, source] of repo.files) {
    if (PLAN_FILE.test(file) || HISTORY.has(file) || named.has(file)) continue;
    const handled = new Set((statementsOf.get(file) ?? []).map(row => row.literal.start));
    const info = repo.lexOf(file);
    let text = source;
    if (info && /\.m?js$/u.test(file)) {
      for (const literal of info.strings) {
        const target = resolveSpec(file, literal.text);
        if (target && shims.has(target) && !handled.has(literal.start) && target !== file) keep(target, `${file} names it in a string`);
        const short = shortNames.get(literal.text.split('#')[0]);
        if (short && !handled.has(literal.start) && short !== file) keep(short, `${file} names it as the source identity '${literal.text}'`);
      }
      // In a script, a path counts where code or a string names it; a comment or a static import is neither.
      const chars = info.bare.split('');
      for (const row of statementsOf.get(file) ?? []) for (let k = row.literal.start; k < row.literal.end; k++) chars[k] = ' ';
      text = chars.join('');
    }
    for (const shim of shims.keys()) {
      if (shim === file || !text.includes(shim) || !mentions(text, shim)) continue;
      // A ratchet baseline or path table lists a deleted path as a count that has fallen to nothing, never as a load.
      if (/\.json$/u.test(file)) { data.set(shim, [...data.get(shim) ?? [], file]); continue; }
      keep(shim, `${/\.md$/u.test(file) ? 'named in the docs by' : 'named by path in'} ${file}`);
    }
  }
  // Apply each file's repoints one at a time, last first so earlier offsets hold, and hold any that breaks the ratchet.
  const ratchet = {
    ceilings: JSON.parse(repo.files.get('packages/gate/data/ceilings/cells-edges.json') ?? '{}'),
    declared: new Set(JSON.parse(repo.files.get('packages/codemap/data/plan/cells.json') ?? '{}').allowedEdges ?? []),
  };
  for (const [file, rows] of edits) {
    const original = repo.files.get(file);
    let source = original;
    const accepted = [];
    for (const row of [...rows].sort((a, b) => b.start - a.start)) {
      const next = applyRows(original, [...accepted, row]);
      const before = cellEdges(file, source);
      if (withinRatchet(ratchet, file, next) || [...cellEdges(file, next)].every(to => before.has(to))) { source = next; accepted.push(row); }
      else keep(row.shim, `repointing ${file} would raise its cross-cell imports past packages/gate/data/ceilings/cells-edges.json`);
    }
    edits.set(file, accepted);
  }
  // A shim a frozen plan shard lists must stay, or the shard would name a deleted file.
  for (const file of [...repo.files.keys()].filter(path => /^packages\/codemap\/data\/plan\/[^/]+\.json$/u.test(path) && isFrozen(path))) {
    const match = /\n *"reexports": (\[[^\]]*\])/u.exec(repo.files.get(file));
    for (const shim of match ? JSON.parse(match[1]) : []) if (shims.has(shim)) keep(shim, `listed in frozen ${file}`);
  }
  const cut = [...shims.keys()].filter(file => !kept.has(file)).sort();
  const cutSet = new Set(cut);
  const rewritten = [];
  const changed = new Map();
  for (const [file, rows] of edits) {
    if (cutSet.has(file)) continue;
    const live = rows.filter(row => cutSet.has(row.shim)).sort((a, b) => b.start - a.start);
    if (!live.length) continue;
    changed.set(file, applyRows(repo.files.get(file), live));
    rewritten.push(...live.map(row => ({ file, shim: row.shim })));
  }
  if (write) {
    for (const [file, source] of changed) writeFileSync(join(root, file), source);
    if (cut.length) gitExecFileSync(['rm', '-q', '--', ...cut], { cwd: root });
    for (const file of [...repo.files.keys()].filter(path => /^packages\/codemap\/data\/plan\/[^/]+\.json$/u.test(path) && !isFrozen(path))) {
      const text = repo.files.get(file);
      const match = /\n( *)"reexports": (\[[^\]]*\])/u.exec(text);
      if (!match) continue;
      const list = JSON.parse(match[2]);
      const left = list.filter(path => !cutSet.has(path));
      if (left.length === list.length) continue;
      const body = left.length ? `[\n${left.map(path => `${match[1]} ${JSON.stringify(path)}`).join(',\n')}\n${match[1]}]` : '[]';
      writeFileSync(join(root, file), text.replace(match[0], `\n${match[1]}"reexports": ${body}`));
    }
  }
  return { found: shims.size, data, cut, kept: [...kept].sort(), rewritten, files: [...changed.keys()].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dry = process.argv.includes('--dry-run');
  const at = process.argv.indexOf('--frozen');
  // --frozen <file> lists one path per line, or a folder ending in /, that this run must not write.
  const frozen = at > 0 ? readFileSync(process.argv[at + 1], 'utf8').split('\n').map(line => line.trim()).filter(Boolean) : [];
  const seen = process.argv.indexOf('--reviewed');
  // --reviewed <file> lists, one per line, files whose path mentions were checked by hand and load nothing.
  const reviewed = seen > 0 ? readFileSync(process.argv[seen + 1], 'utf8').split('\n').map(line => line.trim()).filter(Boolean) : [];
  const result = cutShims(process.cwd(), { write: !dry, frozen, reviewed });
  for (const shim of result.cut) console.log(`cut ${shim}`);
  for (const [shim, reasons] of result.kept) console.log(`kept ${shim}: ${[...new Set(reasons)].join('; ')}`);
  console.log(`${result.found} shims found, ${result.cut.length} cut, ${result.kept.length} kept; ${result.rewritten.length} imports rewritten in ${result.files.length} files`);
}
