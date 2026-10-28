/** Recognize fixture source reads without editing destinations, oracles or unevaluated fixture programs [C7]. */
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { lex } from '../packages/kernel/index.js';
import { bindingReadsForModules } from '../src/cell-binding-uses.js';

const ID = '[A-Za-z_$][\\w$]*';
const READS = new Set(['readFileSync', 'cpSync', 'copyFileSync']);
const REPOSITORY = '/__pullboard_fixture_repo__';

/** Blank spans without changing any source offset or newline. */
function blank(text, start, end) {
  return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/gu, ' ') + text.slice(end);
}

/** Keep only real code tokens at an expression's edges. */
function trim(code, start, end) {
  while (start < end && /\s/u.test(code[start])) start++;
  while (end > start && /\s/u.test(code[end - 1])) end--;
  return { start, end };
}

/** Reuse the same balanced expression ranges for fixture and immutable producer bytes. */
function expressions(code, strings) {
  const literalStarts = new Map(strings.map(value => [value.start, value]));
  /** Find a balanced code delimiter while strings/templates remain indivisible source tokens. */
  function close(at) {
    const pairs = { '(': ')', '[': ']', '{': '}' }, stack = [pairs[code[at]]];
    if (!stack[0]) return -1;
    for (let index = at + 1; index < code.length; index++) {
      const literal = literalStarts.get(index);
      if (literal) { index = literal.end - 1; continue; }
      if (pairs[code[index]]) stack.push(pairs[code[index]]);
      else if (')]}'.includes(code[index])) {
        if (code[index] !== stack.pop()) return -1;
        if (!stack.length) return index;
      }
    }
    return -1;
  }

  /** Split an already balanced argument or list range without interpreting strings or comments. */
  function parts(start, end) {
    const result = [];
    let begin = start;
    for (let at = start; at < end; at++) {
      const literal = literalStarts.get(at);
      if (literal) { at = literal.end - 1; continue; }
      if ('([{'.includes(code[at])) {
        const finish = close(at);
        if (finish < 0 || finish >= end) return null;
        at = finish;
      } else if (code[at] === ',') { result.push(trim(code, begin, at)); begin = at + 1; }
    }
    if (code.slice(begin, end).trim()) result.push(trim(code, begin, end));
    return result;
  }

  return { close, parts };
}

/** A lexer-exposed slash line cannot establish an import declaration inside a possible regular expression. */
function slashLine(source, code, at) {
  let start = at, end = at;
  while (start > 0 && !/[\n\r\u2028\u2029]/u.test(source[start - 1])) start--;
  while (end < source.length && !/[\n\r\u2028\u2029]/u.test(source[end])) end++;
  return code.slice(start, end).includes('/');
}

/** Recognize imported module identities and exclude their declarations from binding-read probes. */
function imports(source, scanned, problems, file) {
  const bindings = new Map();
  let body = scanned.code;
  for (const literal of scanned.strings) {
    const target = /^\.\.?\/[^?#%\\]+\.js$/u.test(literal.text) ? posix.normalize(posix.join(posix.dirname(file), literal.text)) : null;
    const native = ['node:fs', 'fs', 'node:path', 'path', 'node:url', 'url'].includes(literal.text);
    if (!native && (!target || target.startsWith('../') || posix.isAbsolute(target))) continue;
    const before = scanned.code.slice(0, literal.start);
    const match = /\bimport\s*([^;]*?)\bfrom\s*$/u.exec(before);
    if (!match) {
      if (/\b(?:require|import)\s*\(\s*$/u.test(before)) problems.push(`${file}: unsupported dynamic/CommonJS fixture filesystem binding`);
      continue;
    }
    if (slashLine(source, scanned.code, match.index)) { problems.push(`${file}: uncertain fixture import declaration`); continue; }
    const clause = match[1].trim(), module = native ? literal.text.replace(/^node:/u, '') : 'source';
    const namespace = new RegExp(`^\\*\\s*as\\s+(${ID})$`, 'u').exec(clause);
    if (namespace) bindings.set(namespace[1], { module, target, imported: '*' });
    else if (new RegExp(`^${ID}$`, 'u').test(clause)) bindings.set(clause, { module, target, imported: '*' });
    else if (clause.startsWith('{') && clause.endsWith('}')) {
      for (const part of clause.slice(1, -1).split(',').map(value => value.trim()).filter(Boolean)) {
        const named = new RegExp(`^(${ID})(?:\\s+as\\s+(${ID}))?$`, 'u').exec(part);
        if (!named) problems.push(`${file}: unsupported ${module} import binding ${part}`);
        else bindings.set(named[2] ?? named[1], { module, target, imported: named[1] });
      }
    } else problems.push(`${file}: unsupported mixed ${module} import bindings`);
    body = blank(body, match.index, literal.end);
  }
  return { bindings, body };
}

/** Return nonoverlapping source-only edits and explicit unsupported sites; never execute candidate code. */
export function fixtureSourceEdits(source, { file, moves, readSource }) {
  const moved = new Map(moves), edits = [], problems = [];
  if (source.length > 1024 ** 2) return { edits, problems: [`${file}: fixture source analysis exceeds its byte budget`] };
  const scanned = lex(source);
  const { code, strings } = scanned;
  const imported = imports(source, scanned, problems, file);
  if (![...imported.bindings.values()].some(binding => binding.module === 'fs'
    && (binding.imported === '*' || READS.has(binding.imported)))) return { edits, problems };
  const declarations = new Map(), loops = [], consumed = new Set(), scopedReads = new Map(), producers = new Map();
  const literalStarts = new Map(strings.map(value => [value.start, value]));
  const { close, parts } = expressions(code, strings);
  const moduleDirectory = posix.dirname(posix.join(REPOSITORY, file));
  let probeBody = imported.body;
  if (!moved.size) return { edits, problems: [] };

  /** Name an unsupported site without leaking or rewriting the supplied expression. */
  function unsupported(at, reason) {
    problems.push(`${file}:${source.slice(0, at).split('\n').length}: unsupported fixture source: ${reason}`);
  }

  /** Read a plain literal or one finite loop-variable substitution, without evaluating escapes or expressions. */
  function literal(range, substitutions = new Map()) {
    const row = literalStarts.get(range.start);
    if (row && row.end === range.end) {
      if (row.text.includes('\\')) return null;
      if (source[row.start] !== '`' || !row.text.includes('${')) return row.text;
      const template = /^([^$]*)\$\{([A-Za-z_$][\w$]*)\}([^$]*)$/u.exec(row.text);
      return template && substitutions.has(template[2]) ? template[1] + substitutions.get(template[2]) + template[3] : null;
    }
    const name = code.slice(range.start, range.end);
    return substitutions.has(name) ? substitutions.get(name) : null;
  }

  /** Resolve a single call expression, preserving its exact callee and argument offsets. */
  function call(range) {
    const match = new RegExp(`^(${ID})(?:\\s*\\.\\s*(${ID}))?\\s*\\(`, 'u').exec(code.slice(range.start, range.end));
    if (!match) return null;
    const open = range.start + match[0].lastIndexOf('('), end = close(open);
    if (end !== range.end - 1) return null;
    const args = parts(open + 1, end);
    return args && { name: match[1], member: match[2], args, at: range.start,
      callee: source.slice(range.start, open).trim() };
  }

  /** Retain one bounded constant declaration only when its name has one declaration in the module. */
  for (const match of imported.body.matchAll(new RegExp(`\\bconst\\s+(${ID})\\s*=`, 'gu'))) {
    const start = match.index + match[0].length;
    let end = start;
    while (end < code.length && !';\n'.includes(code[end])) {
      const token = literalStarts.get(end);
      if (token) end = token.end;
      else if ('([{'.includes(code[end])) { const finish = close(end); if (finish < 0) break; end = finish + 1; }
      else end++;
    }
    const nameAt = match.index + match[0].indexOf(match[1], 'const'.length);
    const entries = declarations.get(match[1]) ?? [];
    entries.push({ range: trim(code, start, end), at: nameAt });
    declarations.set(match[1], entries);
    if (!imported.bindings.has(match[1]) && match[1] !== 'URL') probeBody = blank(probeBody, nameAt, nameAt + match[1].length);
  }
  for (const match of imported.body.matchAll(new RegExp(`\\bfor\\s*\\(\\s*const\\s+(${ID})\\s+of\\b\\s*`, 'gu'))) {
    const open = code.indexOf('(', match.index), end = close(open);
    if (end < 0) continue;
    const body = trim(code, end + 1, code.length).start;
    let finish, scopeStart;
    if (code[body] === '{') { finish = close(body); scopeStart = body + 1; }
    else {
      const statement = new RegExp(`^${ID}(?:\\s*\\.\\s*${ID})?\\s*\\(`, 'u').exec(code.slice(body));
      if (!statement) continue;
      const openCall = body + statement[0].lastIndexOf('(');
      finish = close(openCall) + 1;
      const after = trim(code, finish, code.length).start;
      if (finish <= openCall || after < code.length && code[after] !== ';') continue;
      scopeStart = body;
    }
    if (finish < 0) continue;
    loops.push({ name: match[1], at: match.index, body, scopeStart, end: finish,
      input: trim(code, match.index + match[0].length, end) });
  }
  const names = [...new Set([...imported.bindings.keys(), ...declarations.keys(), 'URL'])];
  let reads;
  try {
    reads = bindingReadsForModules([{ file, source, body: probeBody, bindings: names.map(local => ({ local })) }]).get(file);
  } catch { return { edits: [], problems: [...problems, `${file}: fixture binding compiler unavailable`] }; }

  const unsafeModules = new Set();
  for (const [name, binding] of imported.bindings) {
    if (binding.imported !== '*' || binding.module === 'source') continue;
    for (const at of reads.get(name)?.reads ?? []) {
      const member = /^\s*\.\s*([A-Za-z_$][\w$]*)/u.exec(code.slice(at + name.length));
      const tail = member && code.slice(at + name.length + member[0].length);
      if (!member || /^\s*(?:=(?!=)|\+\+|--|(?:\?\?|\|\||&&|[+*/%-])=)/u.test(tail)
        || /\bdelete\s*$/u.test(code.slice(0, at))) unsafeModules.add(binding.module);
    }
  }
  const unsafeURL = /\b(?:globalThis|global)\s*\.\s*URL\s*=(?!=)/u.test(code)
    || /\b(?:Object\s*\.\s*(?:assign|defineProperty)|Reflect\s*\.\s*set)\s*\(\s*(?:globalThis|global)\b/u.test(code);

  /** Prove an imported/global binding read, refusing shadowing, assignments and compiler uncertainty. */
  function proven(name, at) {
    const row = reads.get(name);
    if (name === 'URL' && unsafeURL || unsafeModules.has(imported.bindings.get(name)?.module)) return false;
    return row && !row.opaque && !row.potentialShadow && row.reads.includes(at);
  }

  /** Recognize only an actual imported node builtin operation at this call site. */
  function operation(parsed, module, allowed) {
    const binding = imported.bindings.get(parsed?.name);
    const name = binding?.imported === '*' ? parsed.member : !parsed?.member ? binding?.imported : null;
    return binding?.module === module && allowed.includes(name) && proven(parsed.name, parsed.at) ? name : null;
  }

  /** Retain the lexical brace containing a declaration; template-local declarations remain unsupported. */
  function declarationScope(declaration) {
    if (strings.some(token => token.start < declaration.at && token.end > declaration.at)) return null;
    let start = 0, end = code.length;
    for (let index = 0; index < declaration.at; index++) {
      const token = literalStarts.get(index);
      if (token) { index = token.end - 1; continue; }
      if (code[index] === '{') {
        const finish = close(index);
        if (finish >= declaration.at) { start = index + 1; end = finish; }
      }
    }
    return { start, end };
  }

  /** Resolve one nearest containing declaration, including later TDZ shadows, before the existing scoped compiler proof. */
  function constant(name, at) {
    const candidates = (declarations.get(name) ?? []).map(declaration => ({ declaration, scope: declarationScope(declaration) }))
      .filter(row => row.scope && at >= row.scope.start && at < row.scope.end);
    if (!candidates.length) return null;
    const nearest = Math.max(...candidates.map(row => row.scope.start));
    const selected = candidates.filter(row => row.scope.start === nearest);
    if (selected.length !== 1) return null;
    const { declaration, scope: { start, end } } = selected[0];
    if (at < declaration.range.end || /\b(?:case|default)\b/u.test(code.slice(start, end))) return null;
    const key = `${name}:${declaration.at}:${start}:${end}`;
    if (!scopedReads.has(key)) {
      let body = blank(blank(code, 0, start), end, code.length);
      body = blank(body, declaration.at, declaration.at + name.length);
      try { scopedReads.set(key, bindingReadsForModules([{ file, source, body, scopeBraces: true, bindings: [{ local: name }] }]).get(file).get(name)); }
      catch { scopedReads.set(key, null); }
    }
    const row = scopedReads.get(key);
    return row && !row.opaque && !row.potentialShadow && row.reads.includes(at) ? declaration.range : null;
  }

  /** Recognize only finite plain/computed-key dictionaries, including this recognizer's own generated output. */
  function dictionary(range, substitutions, seen) {
    if (code[range.start] !== '(') return null;
    const parenthesis = close(range.start);
    if (parenthesis < 0) return null;
    const index = trim(code, parenthesis + 1, range.end);
    if (code[index.start] !== '[' || close(index.start) !== index.end - 1) return null;
    const variable = code.slice(index.start + 1, index.end - 1).trim();
    if (!substitutions.has(variable)) return null;
    const object = trim(code, range.start + 1, parenthesis);
    if (code[object.start] !== '{' || close(object.start) !== object.end - 1) return null;
    const entries = parts(object.start + 1, object.end - 1), keys = new Set();
    if (!entries || entries.length > 128) return null;
    let selected;
    for (const entry of entries) {
      let keyEnd = literalStarts.get(entry.start)?.end;
      let keyRange = { start: entry.start, end: keyEnd };
      if (code[entry.start] === '[') {
        keyEnd = close(entry.start) + 1;
        keyRange = trim(code, entry.start + 1, keyEnd - 1);
      }
      if (!keyEnd) return null;
      const key = literal(keyRange), colon = trim(code, keyEnd, entry.end).start;
      if (key === null || keys.has(key) || code[colon] !== ':') return null;
      keys.add(key);
      if (key === substitutions.get(variable)) selected = trim(code, colon + 1, entry.end);
    }
    return selected ? path(selected, substitutions, seen) : null;
  }

  /** Resolve only real module-relative roots, explicit direct literals, and proven pure path operations. */
  function path(range, substitutions = new Map(), seen = new Set()) {
    const value = literal(range, substitutions);
    if (value !== null) return { path: posix.resolve(REPOSITORY, value), render: target => JSON.stringify(posix.relative(REPOSITORY, target)) };
    const text = code.slice(range.start, range.end);
    if (text === 'import.meta.dirname') return { path: moduleDirectory, render: target => `new URL(${JSON.stringify(posix.relative(moduleDirectory, target))}, import.meta.url)` };
    if (new RegExp(`^${ID}$`, 'u').test(text)) {
      if (seen.has(text)) return null;
      const declared = constant(text, range.start);
      return declared ? path(declared, substitutions, new Set([...seen, text])) : null;
    }
    const url = /^new\s+URL\s*\(/u.exec(text);
    if (url) {
      const at = range.start + url[0].indexOf('URL'), open = range.start + url[0].lastIndexOf('(');
      const args = close(open) === range.end - 1 && parts(open + 1, range.end - 1);
      const relative = args?.length === 2 ? literal(args[0], substitutions) : null;
      if (relative === null || /[%?#\x00-\x1f]/u.test(relative) || code.slice(args[1].start, args[1].end).replace(/\s/gu, '') !== 'import.meta.url' || !proven('URL', at)) return null;
      return { path: posix.resolve(moduleDirectory, relative), render: target => `new URL(${JSON.stringify(posix.relative(moduleDirectory, target))}, import.meta.url)` };
    }
    const selected = dictionary(range, substitutions, seen);
    if (selected) return selected;
    const parsed = call(range);
    if (!parsed) return null;
    if (operation(parsed, 'fs', ['mkdtempSync'])) return { fixture: true };
    if (operation(parsed, 'url', ['fileURLToPath']) && parsed.args.length === 1) {
      const arg = code.slice(parsed.args[0].start, parsed.args[0].end).replace(/\s/gu, '');
      if (arg === 'import.meta.url') return { path: posix.join(REPOSITORY, file), render: target => `${parsed.callee}(new URL(${JSON.stringify(posix.relative(moduleDirectory, target))}, import.meta.url))` };
    }
    const method = operation(parsed, 'path', ['join', 'resolve', 'dirname']);
    if (!method || !parsed.args.length) return null;
    const base = path(parsed.args[0], substitutions, seen);
    if (!base || base.fixture) return base;
    if (method === 'dirname' && parsed.args.length === 1) return { path: posix.dirname(base.path), render: target => base.render(target) };
    if (method === 'dirname') return null;
    const segments = parsed.args.slice(1).map(arg => literal(arg, substitutions));
    if (segments.some(segment => segment === null)) return null;
    return { path: method === 'join' ? posix.join(base.path, ...segments) : posix.resolve(base.path, ...segments),
      render: target => `${parsed.callee}(${source.slice(parsed.args[0].start, parsed.args[0].end)}, ${JSON.stringify(posix.relative(base.path, target))})` };
  }

  /** Resolve a bounded plain string array; mixed lists and aliases remain explicitly unsupported. */
  function values(range, at) {
    const name = code.slice(range.start, range.end);
    if (new RegExp(`^${ID}$`, 'u').test(name)) {
      const declared = constant(name, range.start);
      const uses = reads.get(name)?.reads ?? [];
      if (!declared || uses.some(use => !loops.some(loop => loop.input.start === use && code.slice(loop.input.start, loop.input.end) === name))) return null;
      range = declared;
    }
    if (code[range.start] !== '[' || close(range.start) !== range.end - 1) return null;
    const entries = parts(range.start + 1, range.end - 1);
    if (!entries || entries.length > 128) return null;
    const list = entries.map(entry => literal(entry));
    return list.length && list.every(value => typeof value === 'string') ? [...new Set(list)] : null;
  }

  /** Prove finite loop-variable reads only inside the matching loop, with nested shadowing still visible to V8. */
  function finite(name, at) {
    const loop = loops.filter(row => row.name === name && at > row.body && at < row.end).at(-1);
    if (!loop) return null;
    let body = blank(code, 0, loop.scopeStart);
    body = blank(body, loop.end, body.length);
    let result;
    try { result = bindingReadsForModules([{ file, source, body, bindings: [{ local: name }] }]).get(file).get(name); }
    catch { return null; }
    if (result.opaque || result.potentialShadow || !result.reads.includes(at)) return null;
    return values(loop.input, loop.at);
  }

  /** Prove one imported zero-argument return leaf from exact regular Git-source bytes, never from its spelling. */
  function producerLeaf(parsed) {
    const binding = imported.bindings.get(parsed?.name);
    if (binding?.module !== 'source' || binding.imported === '*' || parsed.member || parsed.args.length
      || !proven(parsed.name, parsed.at) || typeof readSource !== 'function') return null;
    const key = `${binding.target}#${binding.imported}`;
    let snapshot;
    try { snapshot = readSource(binding.target); } catch { return null; }
    if (!snapshot || typeof snapshot.source !== 'string' || snapshot.source.length > 1024 ** 2
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(snapshot.object ?? '')
      || createHash(snapshot.object.length === 64 ? 'sha256' : 'sha1')
        .update(`blob ${Buffer.byteLength(snapshot.source)}\0`).update(snapshot.source).digest('hex') !== snapshot.object) return null;
    if (producers.has(key)) return producers.get(key).object === snapshot.object ? producers.get(key).leaf : null;
    const scanned = lex(snapshot.source), issues = [], identity = imports(snapshot.source, scanned, issues, binding.target);
    const definitions = [...scanned.code.matchAll(new RegExp(`\\bexport\\s+function\\s+${binding.imported}\\s*\\(\\s*\\)\\s*\\{`, 'gu'))];
    if (issues.length || definitions.length !== 1) return null;
    const definition = definitions[0], open = definition.index + definition[0].lastIndexOf('{');
    const range = expressions(scanned.code, scanned.strings), end = range.close(open);
    const returned = new RegExp(`^\\s*return\\s+(${ID})(?:\\s*\\.\\s*(${ID}))?\\s*\\(`, 'u').exec(scanned.code.slice(open + 1, end));
    if (end < 0 || !returned) return null;
    const callAt = open + 1 + returned.index + returned[0].indexOf(returned[1]);
    const callOpen = open + 1 + returned[0].lastIndexOf('('), callEnd = range.close(callOpen);
    if (scanned.code.slice(callEnd + 1, end).trim() !== ';') return null;
    const args = range.parts(callOpen + 1, callEnd), callee = identity.bindings.get(returned[1]);
    if (!args || args.length !== 2 || callee?.module !== 'path'
      || (callee.imported === '*' ? returned[2] : returned[2] ? null : callee.imported) !== 'join') return null;
    const leaf = scanned.strings.find(row => row.start === args[1].start && row.end === args[1].end)?.text;
    if (!leaf || leaf.includes('${') || /[\\/:\x00-\x1f]/u.test(leaf) || leaf === '.' || leaf === '..') return null;
    const nameAt = definition.index + definition[0].lastIndexOf(binding.imported);
    const body = blank(identity.body, nameAt, nameAt + binding.imported.length);
    const names = [...new Set([returned[1], binding.imported, ...[...identity.bindings]
      .filter(([, row]) => row.module === 'path' && row.imported === '*').map(([name]) => name)])];
    let rows;
    try { rows = bindingReadsForModules([{ file: binding.target, source: snapshot.source, body, scopeBraces: true,
      bindings: names.map(local => ({ local })) }]).get(binding.target); } catch { return null; }
    if (names.some(name => !rows.get(name) || rows.get(name).opaque || rows.get(name).potentialShadow)
      || !rows.get(returned[1]).reads.includes(callAt)) return null;
    for (const [name, row] of identity.bindings) if (row.module === 'path' && row.imported === '*') {
      for (const at of rows.get(name).reads) {
        const member = /^\s*\.\s*[A-Za-z_$][\w$]*/u.exec(scanned.code.slice(at + name.length));
        if (!member || /^\s*(?:=(?!=)|\+\+|--|(?:\?\?|\|\||&&|[+*/%-])=)/u.test(scanned.code.slice(at + name.length + member[0].length))
          || /\bdelete\s*$/u.test(scanned.code.slice(0, at))) return null;
      }
    }
    try { const again = readSource(binding.target); if (again?.object !== snapshot.object || again.source !== snapshot.source) return null; } catch { return null; }
    producers.set(key, { object: snapshot.object, leaf });
    return leaf;
  }

  /** Prove a disjoint regular-file suffix through constants, without guessing what an unknown fixture root means. */
  function leafName(range, seen = new Set()) {
    const value = literal(range);
    if (value !== null) return value;
    const name = code.slice(range.start, range.end);
    if (new RegExp(`^${ID}$`, 'u').test(name)) {
      if (seen.has(name)) return null;
      const declared = constant(name, range.start);
      return declared ? leafName(declared, new Set([...seen, name])) : null;
    }
    const parsed = call(range), method = parsed && operation(parsed, 'path', ['join', 'resolve']);
    return method && parsed.args.length > 1 ? literal(parsed.args.at(-1)) : parsed ? producerLeaf(parsed) : null;
  }

  /** Edit only the fs source argument; unsupported source construction never masquerades as success. */
  function sourceArgument(range, reader, regularFile) {
    const dynamic = [...code.slice(range.start, range.end).matchAll(new RegExp(`\\b(${ID})\\b`, 'gu'))]
      .map(match => ({ name: match[1], at: range.start + match.index })).filter(row => loops.some(loop => loop.name === row.name && row.at > loop.body && row.at < loop.end));
    const variables = [...new Set(dynamic.map(row => row.name))];
    if (variables.length > 1) { unsupported(range.start, 'mixed finite source variables'); return; }
    if (variables.length === 1) {
      const name = variables[0], list = finite(name, dynamic.find(row => row.name === name).at);
      if (!list) { unsupported(range.start, `unknown or shadowed finite source list ${name}`); return; }
      const table = [], found = [];
      for (const value of list) {
        const resolved = path(range, new Map([[name, value]]));
        if (!resolved || resolved.fixture || !resolved.path) { unsupported(range.start, `mixed or unsupported finite source flow ${name}`); return; }
        const target = moved.get(posix.relative(REPOSITORY, resolved.path));
        table.push(`[${JSON.stringify(value)}]: ${resolved.render(target ? posix.join(REPOSITORY, target) : resolved.path)}`);
        found.push(Boolean(target));
      }
      if (found.some(Boolean)) edits.push({ ...range, text: `({${table.join(', ')}})[${name}]` });
      return;
    }
    const resolved = path(range);
    if (resolved?.fixture) return;
    if (!resolved?.path) {
      const leaf = leafName(range);
      if (regularFile && leaf && !leaf.split('/').some(part => part === '.' || part === '..')
        && ![...moved.keys()].some(from => posix.basename(from) === posix.basename(leaf))) return;
      unsupported(range.start, 'unproven input expression or root'); return;
    }
    const target = moved.get(posix.relative(REPOSITORY, resolved.path));
    if (target) {
      if (/\bprocess\s*\.\s*chdir\s*\(/u.test(code)) { unsupported(range.start, 'local cwd mutation makes source identity ambiguous'); return; }
      edits.push({ ...range, text: resolved.render(posix.join(REPOSITORY, target)) });
    } else if (resolved.path !== REPOSITORY && [...moved.keys()].some(from => posix.join(REPOSITORY, from).startsWith(resolved.path + '/'))) {
      unsupported(range.start, 'directory source includes moved files and needs an explicit fixture topology design');
    }
  }

  for (const [name, binding] of imported.bindings) {
    if (binding.module !== 'fs') continue;
    const expression = binding.imported === '*'
      ? new RegExp(`(?<![\\w$.])${name.replaceAll('$', '\\$')}\\s*\\.\\s*(readFileSync|cpSync|copyFileSync)\\s*\\(`, 'gu')
      : READS.has(binding.imported) ? new RegExp(`(?<![\\w$.])${name.replaceAll('$', '\\$')}\\s*\\(`, 'gu') : null;
    if (!expression) continue;
    for (const match of code.matchAll(expression)) {
      consumed.add(match.index);
      if (!proven(name, match.index)) { unsupported(match.index, `unproven filesystem binding ${name}`); continue; }
      const open = match.index + match[0].lastIndexOf('('), end = close(open);
      const args = end >= 0 && parts(open + 1, end);
      if (!args?.length) { unsupported(match.index, 'filesystem input argument is not statically balanced'); continue; }
      const reader = binding.imported === '*' ? match[1] : binding.imported;
      sourceArgument(args[0], reader, reader !== 'cpSync' || args.length < 3);
    }
    for (const at of reads.get(name)?.reads ?? []) {
      if (consumed.has(at)) continue;
      if (READS.has(binding.imported)) unsupported(at, `filesystem reader ${name} escapes a direct source call`);
      else if (binding.imported === '*') {
        const suffix = code.slice(at + name.length);
        const member = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*(\()?/u.exec(suffix);
        if (!member || READS.has(member[1]) || !member[2]) unsupported(at, `filesystem namespace ${name} escapes a proven source operation`);
      }
    }
  }
  edits.sort((left, right) => left.start - right.start);
  for (let at = 1; at < edits.length; at++) {
    if (edits[at].start < edits[at - 1].end) return { edits: [], problems: [...new Set([...problems, `${file}: overlapping fixture source edits`])] };
  }
  return { edits, problems: [...new Set(problems)] };
}
