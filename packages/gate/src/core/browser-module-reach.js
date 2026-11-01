/** Follow named barrel bindings while retaining every module's evaluation effects [C7,O5]. */
import { lex } from '../../../kernel/index.js';

const ID = '[$A-Z_a-z][$\\w]*';

/** Blank source ranges without changing coordinates or line numbers. */
function blank(source, ranges) {
  const result = source.split('');
  for (const [start, end] of ranges) for (let at = start; at < end; at++) if (result[at] !== '\n') result[at] = ' ';
  return result.join('');
}

/** Pair executable delimiters; malformed or unsupported lexical structure grants no pruning. */
function delimiters(code) {
  const stack = [], pairs = new Map(), depths = new Uint32Array(code.length);
  for (let at = 0; at < code.length; at++) {
    depths[at] = stack.length;
    if ('([{'.includes(code[at])) stack.push(at);
    else if (')]}'.includes(code[at])) {
      const start = stack.pop();
      if (start === undefined || '([{'.indexOf(code[start]) !== ')]}'.indexOf(code[at])) return null;
      pairs.set(start, at);
    }
  }
  return stack.length ? null : { pairs, depths };
}

/** Parse bounded named bindings; namespace or unfamiliar bindings retain all exports. */
function names(clause, exporting = false) {
  const out = [];
  let rest = clause.trim();
  if (!rest) return out;
  if (!rest.startsWith('{')) {
    const namespace = new RegExp(`^\\*\\s+as\\s+(${ID})$`, 'u').exec(rest);
    if (!exporting && namespace) return [{ local: namespace[1], imported: '*' }];
    if (exporting || rest.startsWith('*')) return null;
    const first = new RegExp(`^(${ID})(?:\\s*,\\s*|$)`, 'u').exec(rest);
    if (!first) return null;
    out.push({ local: first[1], imported: 'default' });
    rest = rest.slice(first[0].length).trim();
    if (!rest) return out;
  }
  if (!rest.startsWith('{') || !rest.endsWith('}')) return null;
  for (const field of rest.slice(1, -1).split(',').map(value => value.trim()).filter(Boolean)) {
    const match = new RegExp(`^(${ID})(?:\\s+as\\s+(${ID}))?$`, 'u').exec(field);
    if (!match) return null;
    out.push(exporting ? { local: match[1], imported: match[2] ?? match[1] }
      : { local: match[2] ?? match[1], imported: match[1] });
  }
  return out;
}

/** Read static module clauses only; dynamic imports remain conservative ordinary graph edges. */
function clauses(source, code, strings) {
  const rows = [];
  for (const match of code.matchAll(/\b(?:import|export)\b/gu)) {
    const tail = source.slice(match.index);
    const parsed = /^(import)\s+(?:([\w$\s{},*]+?)\s+from\s*)?(['"])([^'"\n\\]+)\3\s*;?/u.exec(tail)
      ?? /^(export)\s+(\*|\*\s+as\s+[$\w]+|\{[^}]*\})\s+from\s*(['"])([^'"\n\\]+)\3\s*;?/u.exec(tail)
      ?? /^(export)\s+(\{[^}]*\})\s*;?/u.exec(tail);
    if (!parsed) continue;
    const literal = parsed[4] === undefined ? null : strings.find(row => row.start >= match.index
      && row.end <= match.index + parsed[0].length && row.text === parsed[4]);
    if (parsed[4] !== undefined && !literal) continue;
    rows.push({ start: match.index, end: match.index + parsed[0].length,
      kind: parsed[1], request: parsed[4], names: names(parsed[2] ?? '', parsed[1] === 'export'), clause: parsed[2] ?? '' });
  }
  return rows;
}

/** Union an export demand; null means every export, and an empty set means evaluation alone. */
function merge(left, right) {
  if (left === null || right === null) return null;
  return new Set([...(left ?? []), ...right]);
}

/**
 * Narrow explicit named-binding demands. Ordinary graph entries retain their prior conservative behavior.
 * Unselected modules still execute their top level, and any function read there remains reachable.
 * The caller must verify every returned compile-only probe before using a narrowed source.
 */
export function browserModuleReach(source, selected = null) {
  const lexical = lex(source), { code, strings } = lexical;
  const opaque = /\b(?:eval|Function)\b|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\})/u.test(code);
  const rows = clauses(source, code, strings);
  const barrel = rows.length > 0 && rows.every(row => row.kind === 'export' && row.request)
    && !blank(code, rows.map(row => [row.start, row.end])).replace(/[;\s]/gu, '');
  let projected = source;
  const proofs = [];
  if (selected !== null) {
    const syntax = delimiters(code);
    // Dynamic scope can observe declarations that are not lexically referenced.
    if (!syntax || opaque || source.length > 1024 * 1024) selected = null;
    else {
      const functions = [];
      for (const match of code.matchAll(new RegExp(`\\b(?:async\\s+)?function\\s*\\*?\\s+(${ID})\\s*\\(`, 'gu'))) {
        if (syntax.depths[match.index] !== 0) continue;
        const before = code.slice(0, match.index).replace(/\bexport(?:\s+default)?\s*$/u, '').trimEnd();
        if (before && !/[;}]$/u.test(before)) continue;
        const open = match.index + match[0].lastIndexOf('('), close = syntax.pairs.get(open);
        if (close === undefined) continue;
        let body = close + 1;
        while (/\s/u.test(code[body] ?? '') && body < code.length) body++;
        if (code[body] !== '{' || !syntax.pairs.has(body)) continue;
        functions.push({ name: match[1], nameAt: match.index + match[0].lastIndexOf(match[1]), start: match.index, end: syntax.pairs.get(body) + 1,
          parameters: [open + 1, close], body: [body + 1, syntax.pairs.get(body)] });
        if (functions.length > 64) return browserModuleReach(source);
      }
      const probe = blank(code, [...rows.map(row => [row.start, row.end]), ...functions.map(row => [row.start, row.end])]);
      const active = new Set();
      /** Treat every read as a possible call or escape; shadowing only makes this more conservative. */
      function retain(text) {
        for (const row of functions) if (new RegExp(`(?<![\\w$])${row.name.replaceAll('$', '\\$')}(?![\\w$])`, 'u').test(text)) active.add(row.name);
      }
      retain(probe);
      for (const row of functions) {
        const exported = /\bexport\s+(?:default\s+)?(?:async\s+)?$/u.test(code.slice(0, row.start));
        if (exported && (selected.has(row.name) || selected.has('default'))) active.add(row.name);
      }
      for (const row of rows.filter(row => row.kind === 'export' && !row.request)) {
        if (row.names === null && selected.size) for (const fn of functions) active.add(fn.name);
        for (const name of row.names ?? []) if (selected.has(name.imported)) active.add(name.local);
      }
      let prior;
      do {
        prior = active.size;
        for (const row of functions) if (active.has(row.name)) retain(code.slice(row.start, row.end));
      } while (prior !== active.size);
      const inactive = functions.filter(row => !active.has(row.name));
      if (inactive.length > 64) selected = null;
      else {
        projected = blank(source, inactive.flatMap(row => [row.parameters, row.body]));
        for (const row of inactive) {
          proofs.push({ source: source.slice(0, row.nameAt) + '0' + source.slice(row.nameAt + row.name.length), compiles: false });
          proofs.push({ source: source.slice(0, row.end - 1) + '\nreturn;\n' + source.slice(row.end - 1), compiles: true });
        }
      }
    }
  }
  const reads = blank(lex(projected).code, rows.map(row => [row.start, row.end]));
  const requests = new Map();
  for (const row of rows.filter(row => row.request)) {
    let demand = null;
    if (row.kind === 'export') {
      if (selected !== null) demand = row.names === null ? row.clause === '*' ? new Set(selected) : null
        : new Set(row.names.filter(name => selected.has(name.imported)).map(name => name.local));
      const namespace = /^\*\s+as\s+([$\w]+)$/u.exec(row.clause);
      if (selected !== null && namespace) demand = selected.has(namespace[1]) ? null : new Set();
    } else if (row.names !== null) {
      const used = row.names.filter(name => new RegExp(`(?<![\\w$])${name.local.replaceAll('$', '\\$')}(?![\\w$])`, 'u').test(reads));
      demand = used.some(name => name.imported === '*') ? null : new Set(used.map(name => name.imported));
      if (selected === null && !row.names.length) demand = null;
    }
    if (opaque) demand = null;
    requests.set(row.request, requests.has(row.request) ? merge(requests.get(row.request), demand) : demand);
  }
  return { source: projected, requests, barrel, proofs };
}
