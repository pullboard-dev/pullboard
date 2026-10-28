/** Commit complete shipped-source fixtures without exceeding the native staged-diff scan bound [C7]. */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { copyPackageFiles } from '../src/package-files.js';
import { readPathMap } from '../src/path-map.js';
import { lex } from '../src/js-lex.js';

/** Find executable hand copies of shipped tool paths; comments and fixture-program strings are not code. */
export function fixtureCopierProblems(source, file = 'fixture.js') {
  if (source.length > 1024 ** 2) return [`${file}: fixture copier source exceeds its analysis bound`];
  const { code, strings } = lex(source), bindings = new Map(), declarations = new Map(), problems = [];
  const pairs = new Map(), stack = [], braces = [];
  for (let at = 0; at < code.length; at++) {
    if ('([{'.includes(code[at])) stack.push(at);
    else if (')]}'.includes(code[at])) {
      const open = stack.pop();
      if (open === undefined || '([{'.indexOf(code[open]) !== ')]}'.indexOf(code[at])) continue;
      pairs.set(open, at);
      if (code[open] === '{') braces.push({ scopeStart: open + 1, scopeEnd: at });
    }
  }
  for (const literal of strings) {
    if (!['fs', 'node:fs'].includes(literal.text)) continue;
    if (/\b(?:require|import)\s*\(\s*$/u.test(code.slice(0, literal.start))) {
      problems.push(`${file}:${source.slice(0, literal.start).split('\n').length}: opaque filesystem binding; use an explicit import and copyPackageFiles`);
      continue;
    }
    const match = /\bimport\s+([^;]*?)\s+from\s*$/u.exec(code.slice(0, literal.start));
    if (!match) continue;
    const clause = match[1].trim(), namespace = /^(?:\*\s+as\s+)?([\w$]+)$/u.exec(clause);
    if (namespace) bindings.set(namespace[1], '*');
    else for (const entry of clause.replace(/^\{|\}$/gu, '').split(',')) {
      const named = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/u.exec(entry);
      if (named) bindings.set(named[2] ?? named[1], named[1]);
    }
  }
  /** Return a balanced call or declaration range without interpreting candidate expressions. */
  function end(start, delimiter) {
    for (let at = start; at < code.length; at++) {
      if (code[at] === delimiter || ')]}'.includes(code[at])) return at;
      if ('([{'.includes(code[at])) { if (!pairs.has(at)) return code.length; at = pairs.get(at); }
    }
    return code.length;
  }
  /** Keep aliases inside their actual containing braces; another fixture's same-named root is not evidence. */
  function scope(at) {
    return braces.filter(row => row.scopeStart <= at && at < row.scopeEnd)
      .sort((a, b) => b.scopeStart - a.scopeStart)[0] ?? { scopeStart: 0, scopeEnd: code.length };
  }
  /** Resolve only the nearest preceding declaration in a containing lexical scope. */
  function declaration(name, at) {
    return (declarations.get(name) ?? []).filter(row => row.start < at && row.scopeStart <= at && at < row.scopeEnd)
      .sort((a, b) => b.scopeStart - a.scopeStart || b.start - a.start).slice(0, 1);
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=/gu)) {
    const start = match.index + match[0].length;
    const rows = declarations.get(match[1]) ?? [];
    rows.push({ start, end: end(start, ';'), ...scope(match.index) }); declarations.set(match[1], rows);
  }
  // Finite manual source lists are also data dependencies of their loop variable.
  for (const match of code.matchAll(/\bfor\s*\(\s*(?:const|let)\s+([\w$]+)\s+of\s*/gu)) {
    const start = match.index + match[0].length;
    const rows = declarations.get(match[1]) ?? [];
    rows.push({ start, end: end(start, ')'), ...scope(match.index) }); declarations.set(match[1], rows);
  }
  /** Follow finite local aliases only; a tool path must be evidenced by a real source expression. */
  function toolPath(start, finish, seen = new Set()) {
    if (seen.size > 128) { problems.push(`${file}: opaque fixture source alias chain`); return true; }
    if (strings.some(row => row.start >= start && row.end <= finish
      && /^(?:\.\.\/|\.\/)*(?:src|bin|packages)(?:\/|$)|^package\.json$/u.test(row.text))) return true;
    for (const match of code.slice(start, finish).matchAll(/\b[\w$]+\b/gu)) {
      if (seen.has(match[0])) continue;
      const next = new Set([...seen, match[0]]);
      if (declaration(match[0], start + match.index).some(row => toolPath(row.start, row.end, next))) return true;
    }
    return false;
  }
  /** Copies between newly allocated private fixture paths are not installed-tool source copies. */
  function privatePath(start, finish, seen = new Set()) {
    if (seen.size > 128) return false;
    if (/\bmkdtempSync\s*\(/u.test(code.slice(start, finish))) return true;
    for (const match of code.slice(start, finish).matchAll(/\b[\w$]+\b/gu)) {
      if (seen.has(match[0])) continue;
      const next = new Set([...seen, match[0]]);
      if (declaration(match[0], start + match.index).some(row => privatePath(row.start, row.end, next))) return true;
      if (!/^\s*\(/u.test(code.slice(start + match.index + match[0].length))) continue;
      const definition = new RegExp(`\\bfunction\\s+${match[0].replaceAll('$', '\\$')}\\s*\\([^)]*\\)\\s*\\{`, 'u').exec(code);
      if (!definition) continue;
      const body = definition.index + definition[0].length, close = end(body, '}');
      const returns = [...code.slice(body, close).matchAll(/\breturn\s+([\w$]+)\s*;/gu)];
      if (returns.length && returns.length === [...code.slice(body, close).matchAll(/\breturn\b/gu)].length
        && returns.every(row => declaration(row[1], body + row.index).some(value => privatePath(value.start, value.end, next)))) return true;
    }
    return false;
  }
  for (const [name, imported] of bindings) {
    const member = imported === '*' ? '\\s*\\.\\s*(cpSync|copyFileSync|writeFileSync)' : '';
    if (imported !== '*' && !['cpSync', 'copyFileSync', 'writeFileSync'].includes(imported)) continue;
    const pattern = new RegExp(`(?<![\\w$.])${name.replaceAll('$', '\\$')}${member}\\s*\\(`, 'gu');
    for (const match of code.matchAll(pattern)) {
      const start = match.index + match[0].length, finish = end(start, ')');
      const operation = imported === '*' ? match[1] : imported;
      const comma = end(start, ',');
      const from = operation === 'writeFileSync' ? comma + 1 : start;
      const to = operation === 'writeFileSync' ? finish : Math.min(comma, finish);
      if (toolPath(from, to) && !privatePath(from, to)) problems.push(`${file}:${source.slice(0, match.index).split('\n').length}: hand ${operation} of shipped tool source; use copyPackageFiles`);
    }
  }
  for (const match of code.matchAll(/\b[\w$]+\s*\.\s*put\s*\(/gu)) {
    const start = match.index + match[0].length, finish = end(start, ')'), comma = end(start, ',');
    if (toolPath(comma + 1, finish) && !privatePath(comma + 1, finish)) {
      problems.push(`${file}:${source.slice(0, match.index).split('\n').length}: hand put of shipped tool source; use copyPackageFiles`);
    }
  }
  return problems;
}

/** Copy only explicitly requested fixture files, finding moved definitions through the committed source map. */
export function copyPackageSubset(source, destination, files) {
  return copyPackageFiles(source, destination, { files, pathMap: readPathMap(source) });
}

// Leave room for diff headers and one added-line marker per byte below the native 8 MiB limit.
const COMMIT_SOURCE_BYTES = 3 * 1024 * 1024;

/** Copy every manifest path and commit bounded groups through the fixture's ordinary Git hooks. */
export function copyCommittedPackageFiles(box, source) {
  const files = copyPackageFiles(source, box.repo);
  let batch = [];
  let bytes = 0;
  /** Commit only this batch, retaining hook checks and all copied paths in the final source tree. */
  function commitBatch() {
    if (!batch.length) return;
    box.git(box.repo, 'add', '--', ...batch);
    box.git(box.repo, 'commit', '-q', '-m', 'test: commit shipped fixture source');
    batch = [];
    bytes = 0;
  }
  for (const file of files) {
    const size = statSync(join(box.repo, file)).size;
    if (bytes + size > COMMIT_SOURCE_BYTES) commitBatch();
    batch.push(file);
    bytes += size;
  }
  commitBatch();
  return files;
}
