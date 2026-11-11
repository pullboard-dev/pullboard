/** Commit complete shipped-source fixtures without exceeding the native staged-diff scan bound [C7]. */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { readPathMap } from '../../../../packages/codemap/index.js';
import { lex } from '../../../../packages/kernel/index.js';
import { bindingReadsForModules } from '../../../../packages/codemap/index.js';

/** Find executable hand copies of shipped tool paths; comments and fixture-program strings are not code. */
export function fixtureCopierProblems(source, file = 'fixture.js') {
  if (source.length > 1024 ** 2) return [`${file}: fixture copier source exceeds its analysis bound`];
  const { code, strings } = lex(source), bindings = new Map(), operations = new Map(), declarations = new Map(), problems = [];
  let probeBody = code;
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
    if (!['fs', 'node:fs', 'path', 'node:path'].includes(literal.text)) continue;
    if (/\b(?:require|import)\s*\(\s*$/u.test(code.slice(0, literal.start))) {
      const before = code.slice(Math.max(0, literal.start - 160), literal.start);
      const binding = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*$/u.exec(before);
      if (binding && new RegExp(`\\b${binding[1]}\\s*\\.\\s*(?:cpSync|copyFileSync|writeFileSync)\\s*\\(`, 'u').test(code)) {
        problems.push(`${file}:${source.slice(0, literal.start).split('\n').length}: opaque filesystem binding; use an explicit import and copyPackageFiles`);
      }
      continue;
    }
    const match = /\bimport\s+([^;]*?)\s+from\s*$/u.exec(code.slice(0, literal.start));
    if (!match) continue;
    probeBody = probeBody.slice(0, match.index) + probeBody.slice(match.index, literal.end).replace(/[^\n]/gu, ' ') + probeBody.slice(literal.end);
    const module = literal.text.replace(/^node:/u, '');
    const clause = match[1].trim(), namespace = /^(?:\*\s+as\s+)?([\w$]+)$/u.exec(clause);
    if (namespace) { if (module === 'fs') bindings.set(namespace[1], '*'); operations.set(namespace[1], { module, imported: '*' }); }
    else for (const entry of clause.replace(/^\{|\}$/gu, '').split(',')) {
      const named = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/u.exec(entry);
      if (named) { if (module === 'fs') bindings.set(named[2] ?? named[1], named[1]); operations.set(named[2] ?? named[1], { module, imported: named[1] }); }
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
    let name = match[1], nameAt = match.index + match[0].indexOf(name, match[0].indexOf(' ') + 1);
    let start = match.index + match[0].length;
    while (true) {
      const finish = Math.min(end(start, ';'), end(start, ',')), rows = declarations.get(name) ?? [];
      rows.push({ start, end: finish, nameAt, immutable: match[0].startsWith('const'), ...scope(match.index) }); declarations.set(name, rows);
      const next = /^,\s*([\w$]+)\s*=/u.exec(code.slice(finish));
      if (!next) break;
      name = next[1]; nameAt = finish + next[0].indexOf(name); start = finish + next[0].length;
    }
  }
  for (const match of code.matchAll(/\b(const|let|var)\s*\{([^{}]*)\}\s*=/gu)) {
    const start = match.index + match[0].length, finish = Math.min(end(start, ';'), end(start, ','));
    for (const entry of match[2].split(',')) {
      const binding = /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?\s*$/u.exec(entry);
      if (!binding) continue;
      const name = binding[2] ?? binding[1], rows = declarations.get(name) ?? [];
      rows.push({ start, end: finish, nameAt: match.index + match[0].indexOf(name), immutable: match[1] === 'const', ...scope(match.index) }); declarations.set(name, rows);
    }
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
    // Shipped tool source: root src and bin, any cell src, and packages outside their own tests folders.
    if (strings.some(row => row.start >= start && row.end <= finish
      && /^(?:\.\.\/|\.\/)*(?:(?:src|bin)(?:\/|$)|packages(?:$|\/(?![\w-]+\/tests\/))|[\w-]+\/src\/)|^package\.json$/u.test(row.text))) return true;
    for (const match of code.slice(start, finish).matchAll(/\b[\w$]+\b/gu)) {
      if (seen.has(match[0])) continue;
      const next = new Set([...seen, match[0]]);
      if (declaration(match[0], start + match.index).some(row => toolPath(row.start, row.end, next))) return true;
    }
    return false;
  }
  const proofs = new Map();
  /** Prove the actual binding at a private-path operation; shadowing, writes and compiler uncertainty never exempt. */
  function proven(name, at, row = null) {
    const key = `${name}:${row?.scopeStart ?? 0}:${row?.scopeEnd ?? code.length}:${row?.nameAt ?? ''}`;
    if (!proofs.has(key)) {
      let body = row ? code.slice(0, row.scopeStart).replace(/[^\n]/gu, ' ') + code.slice(row.scopeStart, row.scopeEnd)
        + code.slice(row.scopeEnd).replace(/[^\n]/gu, ' ') : probeBody;
      if (row) body = body.slice(0, row.nameAt) + ' '.repeat(name.length) + body.slice(row.nameAt + name.length);
      try { proofs.set(key, bindingReadsForModules([{ file, source, body, bindings: [{ local: name }] }]).get(file).get(name)); }
      catch { proofs.set(key, null); }
    }
    const proof = proofs.get(key);
    return proof && !proof.opaque && !proof.potentialShadow && proof.reads.includes(at);
  }
  /** Accept only an exact private-producing expression, never a private branch inside a mixed expression. */
  function privatePath(start, finish, seen = new Set()) {
    if (seen.size > 128) return false;
    while (/\s/u.test(code[start] ?? '') && start < finish) start++;
    while (/\s/u.test(code[finish - 1] ?? '') && finish > start) finish--;
    if (code[start] === '(' && pairs.get(start) === finish - 1) return privatePath(start + 1, finish - 1, seen);
    const text = code.slice(start, finish), identifier = /^[A-Za-z_$][\w$]*$/u.exec(text);
    if (identifier) {
      if (seen.has(text)) return false;
      const row = declaration(text, start)[0];
      return Boolean(row?.immutable && proven(text, start, row) && privatePath(row.start, row.end, new Set([...seen, text])));
    }
    const call = /^([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*\(/u.exec(text);
    if (!call) return false;
    const open = start + call[0].lastIndexOf('(');
    if (pairs.get(open) !== finish - 1) return false;
    const binding = operations.get(call[1]), method = binding?.imported === '*' ? call[2] : !call[2] ? binding?.imported : null;
    if (binding?.imported === '*') return false;
    if (binding && !proven(call[1], start)) return false;
    if (binding?.module === 'fs' && method === 'mkdtempSync') return true;
    if (binding?.module === 'path' && ['join', 'resolve'].includes(method)) {
      const first = end(open + 1, ',');
      // Later operands must be plain relative literals: resolve('/real/source') cannot replace the private base.
      let at = first;
      while (at < finish - 1) {
        const stop = end(at + 1, ',');
        const literal = strings.find(value => value.start >= at + 1 && value.end <= stop
          && !code.slice(at + 1, value.start).trim() && !code.slice(value.end, stop).trim());
        if (!literal || /^(?:[/\\]|[A-Za-z]:)|\$\{|\\/u.test(literal.text)
          || literal.text.split('/').includes('..')) return false;
        at = stop;
      }
      return privatePath(open + 1, Math.min(first, finish - 1), seen);
    }
    // A local factory is accepted only when every return is one proven immutable private alias.
    if (call[2] || seen.has(call[1])) return false;
    const definitions = [...code.matchAll(new RegExp(`\\bfunction\\s+${call[1].replaceAll('$', '\\$')}\\s*\\([^)]*\\)\\s*\\{`, 'gu'))];
    if (definitions.length !== 1) return false;
    const definition = definitions[0], body = definition.index + definition[0].length, close = end(body, '}');
    if (!proven(call[1], start, { ...scope(definition.index), nameAt: definition.index + definition[0].indexOf(call[1], 'function'.length) })) return false;
    const returns = [...code.slice(body, close).matchAll(/\breturn\s+([\w$]+)\s*;/gu)];
    return returns.length > 0 && returns.length === [...code.slice(body, close).matchAll(/\breturn\b/gu)].length
      && returns.every(value => privatePath(body + value.index + value[0].indexOf(value[1]),
        body + value.index + value[0].indexOf(value[1]) + value[1].length, new Set([...seen, call[1]])));
  }
  /** Follow actual read bytes, not path mentions inside launchers or synthetic program strings. */
  function copiedBytes(start, finish, excludedPath = null, seen = new Set()) {
    if (seen.size > 128 || /^\s*JSON\s*\.\s*parse\s*\(/u.test(code.slice(start, finish))) return false;
    for (const match of code.slice(start, finish).matchAll(/\b([\w$]+)(?:\s*\.\s*([\w$]+))?\s*\(/gu)) {
      const binding = operations.get(match[1]);
      const method = binding?.imported === '*' ? match[2] : !match[2] ? binding?.imported : null;
      if (binding?.module !== 'fs' || method !== 'readFileSync') continue;
      const open = start + match.index + match[0].lastIndexOf('('), stop = end(open + 1, ',');
      if (source.slice(open + 1, stop).replace(/\s/gu, '') !== excludedPath
        && toolPath(open + 1, stop) && !privatePath(open + 1, stop)) return true;
    }
    for (const match of code.slice(start, finish).matchAll(/\b[\w$]+\b/gu)) {
      if (seen.has(match[0])) continue;
      const next = new Set([...seen, match[0]]);
      if (declaration(match[0], start + match.index).some(row => copiedBytes(row.start, row.end, excludedPath, next))) return true;
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
      if ((operation === 'writeFileSync' ? copiedBytes(from, to, source.slice(start, comma).replace(/\s/gu, '')) : toolPath(from, to) && !privatePath(from, to))) problems.push(`${file}:${source.slice(0, match.index).split('\n').length}: hand ${operation} of shipped tool source; use copyPackageFiles`);
    }
  }
  for (const match of code.matchAll(/\b[\w$]+\s*\.\s*put\s*\(/gu)) {
    const start = match.index + match[0].length, finish = end(start, ')'), comma = end(start, ',');
    if (copiedBytes(comma + 1, finish)) {
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

/** Copy every manifest path into the project or its tooling dependency, retaining ordinary Git hooks. */
export function copyCommittedPackageFiles(box, source, { directory = '' } = {}) {
  if (directory !== '' && !/^[a-z][a-z0-9-]*$/u.test(directory)) throw new Error('fixture tooling needs one relative directory name');
  const files = copyPackageFiles(source, join(box.repo, directory)).map(file => directory ? `${directory}/${file}` : file);
  commitFixtureFiles(box, files);
  return files;
}

/**
 * Commit a fixture's explicit changed paths in bounded groups, with repository hooks off for the copied source.
 * Why: every file of a fresh copy is new, so the pre-commit shim-import ratchet read main's own accepted imports as
 * added and refused the commit; the scheduler test then waited on a timer that never started and hung every landing.
 */
export function commitFixtureFiles(box, files) {
  let batch = [];
  let bytes = 0;
  /** Commit only this batch of copied source, retaining all copied paths in the final source tree. */
  function commitBatch() {
    if (!batch.length) return;
    box.git(box.repo, 'add', '--', ...batch);
    box.git(box.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'test: commit shipped fixture source');
    batch = [];
    bytes = 0;
  }
  // The cells plan arms the shim-import ratchet, so it lands last: earlier batches carry the source's own shim imports unjudged.
  const planned = file => /^packages\/codemap\/data\/plan*\.json$/u.test(file);
  const ordered = [...new Set(files)].sort((x, y) => Number(planned(x)) - Number(planned(y)));
  for (const file of ordered) {
    if (planned(file) && batch.length && !planned(batch[0])) commitBatch();
    let size;
    try { size = statSync(join(box.repo, file)).size; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      size = Buffer.byteLength(box.git(box.repo, 'show', `HEAD:${file}`));
    }
    if (bytes + size > COMMIT_SOURCE_BYTES) commitBatch();
    batch.push(file);
    bytes += size;
  }
  commitBatch();
}
