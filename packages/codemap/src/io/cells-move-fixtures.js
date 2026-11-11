/** Recognize fixture source reads without editing destinations, oracles or unevaluated fixture programs [C7]. */
import { matchingDataRead } from './cells-data-reads.js';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { lex } from '../../../kernel/index.js';
import { bindingReadsForModules } from './cell/uses.js';
import { localFunctionCallSets } from './cell/uses.js';
import { readOnlyMemberRanges } from './cell/uses.js';
import { stringSuffixDisjoint } from '../logic/path/map/operands.js';
import { repositoryImport } from '../logic/imports.js';
import { canonicalCopierPaths } from './cells-move-mentions.js';
import { operationalMentions } from './cells-move-mentions.js';

const ID = '[A-Za-z_$][\\w$]*';
const READS = new Set(['readFileSync', 'cpSync', 'copyFileSync']);
const REPOSITORY = '/__pullboard_fixture_repo__';
const DATA_FILE = /\.(?:sqlite3?|db|jsonl|log)$/u;
const MAPPED_SOURCE = { module: 'packages/gate/src/io/scan.js', name: 'mappedWorkingSource', fields: ['implementationPath', 'shimPath'] };

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

/** Resolve only immutable declared callable/literal exports, never native namespace aliases or evaluated values. */
function sourceExportPorts(readSource) {
  const captured = new Map(), parsed = new Map(), compiled = new Set();
  const unresolved = Symbol('unresolved export');
  /** Bind each source to its actual Git blob; one proof has a finite module and byte closure. */
  function snapshot(file) {
    let value;
    try { value = readSource?.(file); } catch { return null; }
    if (!value || typeof value.source !== 'string' || value.source.length > 1024 ** 2
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.object ?? '')
      || createHash(value.object.length === 64 ? 'sha256' : 'sha1').update(`blob ${Buffer.byteLength(value.source)}\0`)
        .update(value.source).digest('hex') !== value.object) return null;
    const prior = captured.get(file);
    if (prior && (prior.source !== value.source || prior.object !== value.object)) return null;
    if (!prior && (captured.size >= 32 || [...captured.values()].reduce((sum, row) => sum + row.source.length, value.source.length) > 2 * 1024 ** 2)) return null;
    captured.set(file, value);
    return value;
  }
  /** Use the repository's real Node import-map resolver for closed relative or package specifiers. */
  function target(file, specifier) {
    let map = {};
    if (specifier.startsWith('#')) {
      const manifest = snapshot('package.json');
      if (!manifest) return null;
      try { map = JSON.parse(manifest.source).imports; } catch { return null; }
    }
    return repositoryImport(file, specifier, map);
  }
  /** Record exact public origins; expressions, defaults and unknown export grammar remain unsupported. */
  function surface(file) {
    if (parsed.has(file)) return parsed.get(file);
    const value = snapshot(file);
    if (!value) return null;
    const scanned = lex(value.source), code = scanned.code, rows = new Map(), stars = [];
    const identities = imports(value.source, scanned, [], file, { producer: true }).bindings;
    /** Retain a public name exactly once, including its actual declaration source. */
    function add(name, row) { if (rows.has(name)) return false; rows.set(name, row); return true; }
    for (const match of code.matchAll(/\bexport\b/gu)) {
      if (/\.\s*$/u.test(code.slice(0, match.index))) continue;
      const line = code.slice(code.lastIndexOf('\n', match.index - 1) + 1, match.index);
      if (line.trim() && !/;\s*$/u.test(line) || slashLine(value.source, code, match.index)) return null;
      const rest = code.slice(match.index);
      const declaration = new RegExp(`^export\\s+(?:async\\s+)?(function|class)\\s+(${ID})\\b`, 'u').exec(rest);
      if (declaration) {
        if (!add(declaration[2], { file, name: declaration[2], kind: declaration[1] })) return null;
        continue;
      }
      const primitive = new RegExp(`^export\\s+const\\s+(${ID})\\s*=\\s*(?:[0-9][0-9_]*|true|false|null)\\s*;`, 'u').exec(rest);
      if (primitive) { if (!add(primitive[1], { file, name: primitive[1], kind: 'literal' })) return null; continue; }
      const unknown = new RegExp(`^export\\s+(?:const|let|var)\\s+(${ID})\\s*=`, 'u').exec(rest);
      if (unknown) { if (!add(unknown[1], { file, name: unknown[1], kind: 'unknown' })) return null; continue; }
      const clause = /^export\s*(\*|\{[^}]*\})\s*(from\s*)?/u.exec(rest);
      if (!clause) return null;
      let destination = null;
      if (clause[2]) {
        const at = match.index + rest.indexOf(clause[1]) + clause[1].length;
        const literal = scanned.strings.find(row => row.start >= at && /^\s*from\s*$/u.test(code.slice(at, row.start)));
        if (!literal || !(destination = target(file, literal.text))) return null;
      }
      if (clause[1] === '*') { if (!destination) return null; stars.push(destination); continue; }
      const parts = clause[1].slice(1, -1).split(',');
      if (!parts.at(-1).trim()) parts.pop(); // Only a final grammar-permitted comma; interior empty entries still refuse.
      for (const part of parts) {
        const names = new RegExp(`^\\s*(${ID})(?:\\s+as\\s+(${ID}))?\\s*$`, 'u').exec(part);
        if (!names) return null;
        const local = names[1], name = names[2] ?? local, binding = identities.get(local);
        const origin = destination ?? (binding?.module === 'source' && binding.imported !== '*' ? binding.target : null);
        if (!origin || !add(name, { to: origin, name: destination ? local : binding.imported })) return null;
      }
    }
    const result = { rows, stars };
    parsed.set(file, result);
    return result;
  }
  /** Follow a finite exact named reexport chain, refusing ambiguous stars and every cycle. */
  function named(file, name, seen = new Set()) {
    const key = `${file}#${name}`;
    if (seen.has(key) || seen.size >= 8) return unresolved;
    const module = surface(file);
    if (!module) return unresolved;
    const next = new Set([...seen, key]), row = module.rows.get(name);
    if (row) return row.to ? named(row.to, row.name, next) : row.kind === 'unknown' ? unresolved : row;
    const candidates = module.stars.map(to => named(to, name, next));
    if (candidates.includes(unresolved)) return unresolved;
    const matches = candidates.filter(Boolean);
    return matches.length > 1 ? unresolved : matches[0] ?? null;
  }
  /** Enumerate only proven export origins; star cycles never become an empty successful surface. */
  function all(file, seen = new Set()) {
    if (seen.has(file) || seen.size >= 8) return null;
    const module = surface(file);
    if (!module) return null;
    const names = new Set(module.rows.keys());
    for (const to of module.stars) {
      const inherited = all(to, new Set([...seen, file]));
      if (!inherited) return null;
      for (const name of inherited) names.add(name);
    }
    return names.size && [...names].every(name => {
      const origin = named(file, name);
      if (!origin || origin === unresolved) return false;
      const value = snapshot(origin.file), scanned = value && lex(value.source);
      if (!scanned || /\b(?:readFileSync|copyFileSync|cpSync)\b/u.test(scanned.code)) return false;
      const bindings = imports(value.source, scanned, [], origin.file, { producer: true }).bindings;
      return ![...bindings.values()].some(binding => binding.module === 'fs' && binding.imported === '*');
    }) ? names : null;
  }
  /** Recheck captured immutable bytes before granting ordinary API-origin authority. */
  function stable() {
    if (![...captured].every(([file, value]) => snapshot(file)?.object === value.object)) return false;
    const pending = [...captured].filter(([file, value]) => file.endsWith('.js') && !compiled.has(value.object));
    try {
      const rows = bindingReadsForModules(pending.map(([file, value]) => ({ file, source: value.source, body: '', bindings: [{ local: '__source_port_probe' }] })));
      if (pending.some(([file]) => rows.get(file)?.get('__source_port_probe')?.opaque)) return false;
      for (const [, value] of pending) compiled.add(value.object);
      return true;
    } catch (error) { if (error?.code === 'CELL_BINDING_TIMEOUT') throw error; return false; }
  }
  return { named: (file, name) => { const row = named(file, name); return row && row !== unresolved && stable() ? row : null; },
    all: file => Boolean(all(file) && stable()) };
}

/** Recognize imported module identities and exclude their declarations from binding-read probes. */
function imports(source, scanned, problems, file, { producer = false, dynamicPort } = {}) {
  const bindings = new Map();
  let body = scanned.code;
  for (const literal of scanned.strings) {
    const target = /^\.\.?\/[^?#%\\]+\.js$/u.test(literal.text) ? posix.normalize(posix.join(posix.dirname(file), literal.text)) : null;
    const native = ['node:fs', 'fs', 'node:path', 'path', 'node:url', 'url', 'node:process', 'process'].includes(literal.text);
    if (!native && (!target || target.startsWith('../') || posix.isAbsolute(target))) continue;
    const before = scanned.code.slice(0, literal.start);
    const match = /\bimport\s*([^;]*?)\bfrom\s*$/u.exec(before);
    if (!match) {
      if (/\b(?:require|import)\s*\(\s*$/u.test(before)
        && !(target && /\bimport\s*\(\s*$/u.test(before) && (producer || dynamicPort?.(target)))) {
        problems.push(`${file}:${source.slice(0, literal.start).split('\n').length}: unsupported fixture source: dynamic/CommonJS fixture filesystem binding`);
      }
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
function fixtureSourceEditsImpl(source, { file, moves, readSource, dataReads = [], mentionsOnly = false }) {
  const moved = new Map(moves), edits = [], problems = [], excluded = [];
  if (source.length > 1024 ** 2) return { edits, problems: [`${file}: fixture source analysis exceeds its byte budget`] };
  const scanned = lex(source);
  const { code, strings } = scanned;
  // A file that only addresses a moved module (import, file URL, toolSourcePath) holds no read to repoint.
  if (mentionsOnly && !dataReads.some(row => row.file === file)) {
    // The copier exempts a mention only where its callee resolves to the imported binding, never a shadow or lookalike.
    // Imports come from the lexed declarations (strings and comments blanked), never from raw text.
    const real = imports(source, scanned, [], file);
    const copierNames = new Set([...real.bindings].filter(([, row]) => row.module === 'source' && row.imported === 'toolSourcePath'
      && canonicalCopierPaths().has(row.target)).map(([name]) => name));
    let copierReads = null;
    const provenCopier = (name, at) => {
      if (!copierReads) {
        try {
          copierReads = bindingReadsForModules([{ file, source, body: real.body, bindings: [...copierNames].map(local => ({ local })) }]).get(file);
        } catch (error) { if (error?.code === 'CELL_BINDING_TIMEOUT') throw error; copierReads = new Map(); }
      }
      const row = copierReads.get(name);
      return Boolean(row && !row.opaque && !row.potentialShadow && row.reads.includes(at));
    };
    const readerNames = new Set([...real.bindings].filter(([, row]) => row.module === 'fs' && READS.has(row.imported)).map(([name]) => name));
    const operationNames = new Set([...real.bindings].filter(([, row]) =>
      row.module === 'fs' && READS.has(row.imported)
      || row.module === 'path' && ['join', 'resolve', 'dirname', 'normalize', 'relative', 'basename', 'extname', 'isAbsolute'].includes(row.imported)).map(([name]) => name));
    let readerReads = null;
    const provenOperation = (name, at) => {
      if (!operationNames.has(name)) return false;
      if (!readerReads) {
        try {
          readerReads = bindingReadsForModules([{ file, source, body: real.body, bindings: [...operationNames].map(local => ({ local })) }]).get(file);
        } catch (error) { if (error?.code === 'CELL_BINDING_TIMEOUT') throw error; readerReads = new Map(); }
      }
      const row = readerReads.get(name);
      return Boolean(row && !row.opaque && !row.potentialShadow && row.reads.includes(at));
    };
    const provenReader = (name, at) => readerNames.has(name) && provenOperation(name, at);
    if (!operationalMentions(source, scanned, moves.map(([from]) => from), copierNames, provenCopier, provenReader, provenOperation).length) return { edits, problems };
  }
  const ports = sourceExportPorts(readSource);
  let sourcePortsUsed = false;
  const imported = imports(source, scanned, problems, file, { dynamicPort: target => {
    const proven = ports.all(target);
    sourcePortsUsed ||= proven;
    return proven;
  } });
  /** Callable origin does not authorize a returned filesystem namespace or an extracted reader. */
  function returnedFilesystemCapabilities() {
    if (!sourcePortsUsed) return;
    for (const site of code.matchAll(/\]\s*(?:\?\.)?\s*\(|\b(?:Reflect\s*\.\s*get|Object\s*\.\s*getOwnPropertyDescriptors?)\s*\(|\b(?:const|let|var)\s*\{[^}]*\[/gu)) {
      problems.push(`${file}:${source.slice(0, site.index).split('\n').length}: unsupported fixture source: computed or reflected returned capability is not a proven fixture input port`);
    }
    for (const match of imported.body.matchAll(/\b(readFileSync|copyFileSync|cpSync)\b/gu)) {
      const before = code.slice(0, match.index), after = code.slice(match.index + match[0].length);
      const member = /\.\s*$/u.test(before);
      const receiver = /([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*$/u.exec(before);
      const binding = imported.bindings.get(member ? receiver?.[1] : match[0]);
      if (/[{: ,]\s*$/u.test(before) && /^\s*[:,}]/u.test(after)) {
        problems.push(`${file}: extracted filesystem property is not a proven fixture input port`);
        continue;
      }
      if (binding?.module === 'fs') continue; // The existing native binding/escape proof remains authoritative.
      if (member || /^\s*(?:\?\.)?\(/u.test(after)) {
        problems.push(`${file}: returned or extracted filesystem capability is not a proven fixture input port`);
      }
    }
    for (const literal of strings) if (READS.has(literal.text)
      && /\[\s*$/u.test(code.slice(0, literal.start)) && /^\s*\]/u.test(code.slice(literal.end))) {
      problems.push(`${file}: computed filesystem capability is not a proven fixture input port`);
    }
  }
  returnedFilesystemCapabilities();
  if (![...imported.bindings.values()].some(binding => binding.module === 'fs'
    && (binding.imported === '*' || READS.has(binding.imported)))) return { edits, problems };
  const declarations = new Map(), loops = [], consumed = new Set(), scopedReads = new Map(), producers = new Map();
  const matchedDataReads = [];
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
    const declared = parts(start, end);
    if (!declared || declared.length > 128) continue;
    for (const [index, entry] of declared.entries()) {
      const next = index ? new RegExp(`^(${ID})\\s*=`, 'u').exec(code.slice(entry.start, entry.end)) : null;
      if (index && !next) continue;
      const name = index ? next[1] : match[1];
      const nameAt = index ? entry.start : match.index + match[0].indexOf(name, 'const'.length);
      const range = index ? trim(code, entry.start + next[0].length, entry.end) : entry;
      const entries = declarations.get(name) ?? [];
      entries.push({ range, at: nameAt });
      declarations.set(name, entries);
      if (!imported.bindings.has(name) && name !== 'URL') probeBody = blank(probeBody, nameAt, nameAt + name.length);
    }
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
  } catch (error) {
    if (error?.code === 'CELL_BINDING_TIMEOUT') throw error;
    return { edits: [], problems: [...problems, `${file}: fixture binding compiler unavailable: ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? String(error)}`] };
  }
  if ([...reads.values()].some(row => row.opaque === 'original module does not compile within the source budget'))
    return { edits: [], problems: [...problems, `${file}: fixture source does not compile`] };

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
      catch (error) { if (error?.code === 'CELL_BINDING_TIMEOUT') throw error; scopedReads.set(key, null); }
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
    if (operation(parsed, 'fs', ['realpathSync']) && parsed.args.length === 1) {
      const value = path(parsed.args[0], substitutions, seen);
      if (value?.fixture) return value;
    }
    // The canonical copier's resolver follows shims to the moved body in every fixture, for any move.
    const copier = imported.bindings.get(parsed.name);
    if (!parsed.member && copier?.module === 'source' && copier.imported === 'toolSourcePath'
      && canonicalCopierPaths().has(copier.target) && proven(parsed.name, parsed.at)) return { fixture: true };
    if (operation(parsed, 'url', ['fileURLToPath']) && parsed.args.length === 1) {
      const arg = code.slice(parsed.args[0].start, parsed.args[0].end).replace(/\s/gu, '');
      if (arg === 'import.meta.url') return { path: posix.join(REPOSITORY, file), render: target => `${parsed.callee}(new URL(${JSON.stringify(posix.relative(moduleDirectory, target))}, import.meta.url))` };
      const nested = /^new\s+URL\s*\(/u.exec(code.slice(parsed.args[0].start, parsed.args[0].end));
      if (!nested) return null;
      const open = parsed.args[0].start + nested[0].lastIndexOf('(');
      const args = close(open) === parsed.args[0].end - 1 && parts(open + 1, parsed.args[0].end - 1);
      const relative = args?.length === 2 ? literal(args[0], substitutions) : null;
      if (relative === null || !/^(?:\.{1,2}(?:\/|$))/u.test(relative)) return null;
      const resolved = path(parsed.args[0], substitutions, seen);
      return resolved?.path ? { path: resolved.path, render: target => `${parsed.callee}(${resolved.render(target)})` } : null;
    }
    const method = operation(parsed, 'path', ['join', 'resolve', 'dirname']);
    if (!method || !parsed.args.length) return null;
    const base = path(parsed.args[0], substitutions, seen);
    if (!base) return null;
    if (base.fixture) {
      // A fresh directory proves only its descendants; dirname, absolute resets and parent traversal can escape it.
      if (method === 'dirname') return null;
      const segments = parsed.args.slice(1).map(arg => literal(arg, substitutions));
      return segments.every(segment => typeof segment === 'string' && segment && !posix.isAbsolute(segment)
        && !segment.split('/').includes('..')) ? base : null;
    }
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
    catch (error) { if (error?.code === 'CELL_BINDING_TIMEOUT') throw error; return null; }
    if (result.opaque || result.potentialShadow || !result.reads.includes(at)) return null;
    return values(loop.input, loop.at);
  }

  /** Read and verify the exact immutable producer blob without importing or evaluating it. */
  function producerSnapshot(target) {
    let snapshot;
    try { snapshot = readSource?.(target); } catch { return null; }
    return snapshot && typeof snapshot.source === 'string' && snapshot.source.length <= 1024 ** 2
      && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(snapshot.object ?? '')
      && createHash(snapshot.object.length === 64 ? 'sha256' : 'sha1')
        .update(`blob ${Buffer.byteLength(snapshot.source)}\0`).update(snapshot.source).digest('hex') === snapshot.object ? snapshot : null;
  }

  /** Follow only explicit constant exports; unknown exports, cycles and runtime expressions stay unsupported. */
  function producerConstant(target, name, seen = new Set()) {
    const key = `${target}#${name}`;
    if (seen.has(key) || seen.size >= 8) return null;
    const snapshot = producerSnapshot(target);
    if (!snapshot) return null;
    const scanned = lex(snapshot.source), values = [];
    for (const match of scanned.code.matchAll(new RegExp(`\\bexport\\s+const\\s+${name}\\s*=\\s*`, 'gu'))) {
      if (slashLine(snapshot.source, scanned.code, match.index)) return null;
      const at = match.index + match[0].length, token = scanned.strings.find(row => row.start === at);
      const end = scanned.code.indexOf(';', at);
      if (!token || end < token.end || scanned.code.slice(token.end, end).trim()
        || token.text.includes('\\') || token.text.includes('${')) return null;
      values.push(token.text);
    }
    for (const token of scanned.strings) {
      const match = /\bexport\s*\{([^{}]*)\}\s*from\s*$/u.exec(scanned.code.slice(0, token.start));
      if (!match) continue;
      if (slashLine(snapshot.source, scanned.code, match.index)) return null;
      for (const entry of match[1].split(',')) {
        const names = new RegExp(`^\\s*(${ID})(?:\\s+as\\s+(${ID}))?\\s*$`, 'u').exec(entry);
        if (!names || (names[2] ?? names[1]) !== name) continue;
        if (!/^\.\.?\/[^?#%\\]+\.js$/u.test(token.text)) return null;
        const next = posix.normalize(posix.join(posix.dirname(target), token.text));
        if (next.startsWith('../') || posix.isAbsolute(next)) return null;
        values.push(producerConstant(next, names[1], new Set([...seen, key])));
      }
    }
    const again = producerSnapshot(target);
    return values.length === 1 && typeof values[0] === 'string'
      && again?.object === snapshot.object && again.source === snapshot.source ? values[0] : null;
  }

  /** Prove one imported fixed-leaf return from exact Git bytes; arguments never establish a root identity. */
  function producerLeaf(parsed) {
    const binding = imported.bindings.get(parsed?.name);
    if (binding?.module !== 'source' || binding.imported === '*' || parsed.member
      || !proven(parsed.name, parsed.at) || typeof readSource !== 'function') return null;
    const origin = ports.named(binding.target, binding.imported);
    if (!origin || origin.kind !== 'function') return null;
    const key = `${binding.target}#${binding.imported}/${parsed.args.length}`;
    const snapshot = producerSnapshot(origin.file);
    if (!snapshot) return null;
    if (producers.has(key)) return producers.get(key).object === snapshot.object ? producers.get(key).leaf : null;
    const scanned = lex(snapshot.source), issues = [], identity = imports(snapshot.source, scanned, issues, origin.file, { producer: true });
    const definitions = [...scanned.code.matchAll(new RegExp(`\\bexport\\s+function\\s+${origin.name}\\s*\\(([^()]*)\\)\\s*\\{`, 'gu'))];
    if (issues.length || definitions.length !== 1) return null;
    const definition = definitions[0], parameters = definition[1].split(',').map(value => value.trim()).filter(Boolean);
    if (parameters.length !== parsed.args.length || new Set(parameters).size !== parameters.length
      || parameters.some(value => !new RegExp(`^${ID}$`, 'u').test(value))) return null;
    const open = definition.index + definition[0].lastIndexOf('{');
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
    const nameAt = definition.index + definition[0].lastIndexOf(origin.name);
    const body = blank(identity.body, nameAt, nameAt + origin.name.length);
    const names = [...new Set([returned[1], origin.name, ...[...identity.bindings]
      .filter(([, row]) => row.module === 'path' && row.imported === '*').map(([name]) => name)])];
    let rows;
    try { rows = bindingReadsForModules([{ file: origin.file, source: snapshot.source, body, scopeBraces: true,
      bindings: names.map(local => ({ local })) }]).get(origin.file); } catch (error) { if (error?.code === 'CELL_BINDING_TIMEOUT') throw error; return null; }
    if (names.some(name => !rows.get(name) || rows.get(name).opaque || rows.get(name).potentialShadow)
      || !rows.get(returned[1]).reads.includes(callAt)) return null;
    for (const [name, row] of identity.bindings) if (row.module === 'path' && row.imported === '*') {
      for (const at of rows.get(name).reads) {
        const member = /^\s*\.\s*[A-Za-z_$][\w$]*/u.exec(scanned.code.slice(at + name.length));
        if (!member || /^\s*(?:=(?!=)|\+\+|--|(?:\?\?|\|\||&&|[+*/%-])=)/u.test(scanned.code.slice(at + name.length + member[0].length))
          || /\bdelete\s*$/u.test(scanned.code.slice(0, at))) return null;
      }
    }
    try { const again = readSource(origin.file); if (again?.object !== snapshot.object || again.source !== snapshot.source) return null; } catch { return null; }
    producers.set(key, { object: snapshot.object, leaf });
    return leaf;
  }

  /** Prove a disjoint regular-file suffix through constants, without guessing what an unknown fixture root means. */
  function leafName(range, seen = new Set()) {
    const value = closedString(range);
    if (value !== null) return value;
    const name = code.slice(range.start, range.end);
    if (new RegExp(`^${ID}$`, 'u').test(name)) {
      if (seen.has(name)) return null;
      const declared = constant(name, range.start);
      return declared ? leafName(declared, new Set([...seen, name])) : null;
    }
    const parsed = call(range), method = parsed && operation(parsed, 'path', ['join', 'resolve']);
    return method && parsed.args.length > 1 ? leafName(parsed.args.at(-1), seen) : parsed ? producerLeaf(parsed) : null;
  }

  /** A proven whole string tail cannot name any moved basename, regardless of its unevaluated prefix. */
  function disjointSuffix(range, seen = new Set()) {
    const name = code.slice(range.start, range.end);
    if (new RegExp(`^${ID}$`, 'u').test(name)) {
      const declared = !seen.has(name) && constant(name, range.start);
      return declared ? disjointSuffix(declared, new Set([...seen, name])) : false;
    }
    const parsed = call(range);
    if (parsed && operation(parsed, 'path', ['join']) && parsed.args.length > 1) return disjointSuffix(parsed.args.at(-1), seen);
    return stringSuffixDisjoint({ source, code, strings, range, close }, [...moved.keys()].map(from => posix.basename(from)));
  }

  /** Resolve an immutable string operand without evaluating a caller or a computed property. */
  function closedString(range, seen = new Set()) {
    const value = literal(range);
    if (value !== null) return value;
    const name = code.slice(range.start, range.end);
    if (!new RegExp(`^${ID}$`, 'u').test(name) || seen.has(name)) return null;
    const declared = constant(name, range.start);
    if (declared) return closedString(declared, new Set([...seen, name]));
    const binding = imported.bindings.get(name);
    return binding?.module === 'source' && binding.imported !== '*' && proven(name, range.start)
      ? producerConstant(binding.target, binding.imported) : null;
  }

  /** Collect only complete immutable trailing segments; parent traversal or absolute resets prove nothing. */
  function closedPathTail(range) {
    const parsed = call(range);
    if (!parsed || !operation(parsed, 'path', ['join', 'resolve']) || parsed.args.length < 2) return null;
    const tail = [];
    for (let index = parsed.args.length - 1; index > 0; index--) {
      const value = closedString(parsed.args[index]);
      if (value === null) break;
      if (!value || posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) return null;
      tail.unshift(...value.split('/'));
    }
    return tail.length ? tail : null;
  }

  /** A closed regular-file tail cannot name an old source; directories may carry source indirectly. */
  function disjointPathTail(range) {
    const tail = closedPathTail(range);
    if (!tail) return false;
    const suffix = tail.join('/');
    return ![...moved.keys()].some(from => from === suffix || from.endsWith('/' + suffix));
  }

  /** Name a board or data file root: its declaration ends in a data-file name no moved source shares, so it cannot be a tracked source path. */
  function dataRoot(range) {
    const match = new RegExp(`^(?:${ID}\\s*\\.\\s*)?(${ID})$`, 'u').exec(code.slice(range.start, range.end));
    const entries = match && declarations.get(match[1]);
    if (!entries?.length) return null;
    const movedNames = new Set([...moved.keys()].map(from => posix.basename(from)));
    let leaf = null;
    for (const entry of entries) {
      const last = strings.filter(row => row.start >= entry.range.start && row.end <= entry.range.end).at(-1);
      leaf = last && !last.text.includes('${') && !last.text.includes('\\') ? posix.basename(last.text) : null;
      if (!leaf || !DATA_FILE.test(leaf) || movedNames.has(leaf)) return null;
    }
    return leaf;
  }

  let functions;
  const parameterProofs = new Map(), receiverProofs = new Map();
  /** Load complete compiler-proven caller sets once; unsupported syntax grants no parameter authority. */
  function localFunctions() {
    if (functions === undefined) {
      try { functions = localFunctionCallSets(source, { file }); }
      catch { functions = []; }
    }
    return functions;
  }

  /** A helper's path value may be observed only as a direct operand of a proven native path or filesystem call. */
  function nativePathOperand(at, length, fn) {
    for (let open = at - 1; open >= fn.bodyStart; open--) {
      if (code[open] !== '(') continue;
      const end = close(open);
      if (end < at + length) continue;
      const callee = new RegExp(`(${ID})(?:\\s*\\.\\s*(${ID}))?\\s*$`, 'u').exec(code.slice(fn.bodyStart, open));
      if (!callee) return false;
      const parsed = call({ start: fn.bodyStart + callee.index, end: end + 1 });
      return Boolean(parsed?.args.some(arg => arg.start === at && arg.end === at + length)
        && (operation(parsed, 'fs', ['readFileSync', 'copyFileSync', 'cpSync', 'existsSync', 'statSync', 'lstatSync'])
          || operation(parsed, 'path', ['join', 'resolve', 'dirname']) || operation(parsed, 'url', ['fileURLToPath'])));
    }
    return false;
  }

  /** Substitute only a complete direct caller set for one immutable, unshadowed scalar parameter read. */
  function helperArguments(range) {
    const name = code.slice(range.start, range.end);
    if (!new RegExp(`^${ID}$`, 'u').test(name)) return null;
    const fn = localFunctions().filter(row => range.start >= row.bodyStart && range.end <= row.bodyEnd)
      .sort((left, right) => right.bodyStart - left.bodyStart)[0];
    if (!fn?.calls.length) return null;
    const parameters = parts(fn.parameterStart, fn.parameterEnd);
    const index = parameters?.findIndex(parameter => code.slice(parameter.start, parameter.end) === name);
    if (index === undefined || index < 0 || parameters.some(parameter => !new RegExp(`^${ID}$`, 'u').test(code.slice(parameter.start, parameter.end)))) return null;
    const key = `${fn.nameAt}:${name}`;
    if (!parameterProofs.has(key)) {
      const body = blank(blank(code, 0, fn.bodyStart), fn.bodyEnd, code.length);
      let row;
      try { row = bindingReadsForModules([{ file, source, body, scopeBraces: true, bindings: [{ local: name }] }]).get(file).get(name); }
      catch (error) { if (error?.code === 'CELL_BINDING_TIMEOUT') throw error; row = null; }
      parameterProofs.set(key, row && !row.opaque && !row.potentialShadow
        && row.reads.every(at => nativePathOperand(at, name.length, fn)) ? row : null);
    }
    const proof = parameterProofs.get(key);
    return proof?.reads.includes(range.start) && fn.calls.every(site => site.args[index]) ? fn.calls.map(site => site.args[index]) : null;
  }

  /** Select an explicit own return field; later spreads, computed keys and prototype setters cannot establish it. */
  function objectField(range, name) {
    if (code[range.start] !== '{' || close(range.start) !== range.end - 1) return null;
    const entries = parts(range.start + 1, range.end - 1);
    if (!entries || entries.length > 128) return null;
    let selected = null;
    for (const entry of entries) {
      const text = code.slice(entry.start, entry.end);
      const field = new RegExp(`^(${ID})(?:\\s*:\\s*|$)`, 'u').exec(text);
      if (!field) { selected = null; continue; }
      if (field[1] === '__proto__') return null;
      if (field[1] === name) selected = field[0].includes(':')
        ? trim(code, entry.start + field[0].length, entry.end) : { start: entry.start, end: entry.start + name.length };
    }
    return selected;
  }

  /** Reject receiver escapes, writes and arbitrary methods instead of trusting a repeated property spelling. */
  function immutableReceiver(name, at, declared) {
    const entry = (declarations.get(name) ?? []).find(row => row.range === declared);
    const scope = entry && declarationScope(entry);
    if (!scope) return false;
    const row = scopedReads.get(`${name}:${entry.at}:${scope.start}:${scope.end}`);
    if (!row || row.opaque || row.potentialShadow || !row.reads.includes(at)) return false;
    const ranges = [];
    if (!row.reads.every(read => {
      const member = new RegExp(`^\\s*(?:\\.\\s*${ID}\\s*)+`, 'u').exec(code.slice(read + name.length));
      if (!member || /\bdelete\s*(?:\(\s*)*$/u.test(code.slice(0, read))) return false;
      if (/^\s*(?:\(|\[|=(?!=)|\+\+|--|(?:\?\?|\|\||&&|[+*/%&|^\-])=)/u.test(code.slice(read + name.length + member[0].length))) return false;
      ranges.push({ start: read, end: read + name.length + member[0].trimEnd().length });
      return true;
    })) return false;
    const key = `${name}:${entry.at}:${scope.start}:${scope.end}`;
    if (!receiverProofs.has(key)) {
      try { receiverProofs.set(key, readOnlyMemberRanges(source, ranges)); }
      catch (error) { if (error?.code === 'CELL_BINDING_TIMEOUT') throw error; receiverProofs.set(key, new Set()); } // Unavailable compiler evidence never authorizes a receiver.
    }
    return ranges.every(range => receiverProofs.get(key).has(range.start));
  }

  /** Follow one actual local factory call to a generated own field, never granting source-returning factories authority. */
  function factoryField(range) {
    const member = new RegExp(`^(${ID})\\s*\\.\\s*(${ID})$`, 'u').exec(code.slice(range.start, range.end));
    if (!member) return null;
    const declared = constant(member[1], range.start);
    if (!declared || !immutableReceiver(member[1], range.start, declared)) return null;
    const invoked = call(declared);
    if (!invoked || invoked.member) return null;
    const fn = localFunctions().find(row => row.name === invoked.name && row.calls.some(site => site.at === invoked.at));
    if (!fn || /\bthis\b/u.test(code.slice(fn.bodyStart, fn.bodyEnd))) return null;
    const returns = [...code.slice(fn.bodyStart, fn.bodyEnd).matchAll(/\breturn\b/gu)];
    if (returns.length !== 1) return null;
    const returned = trim(code, fn.bodyStart + returns[0].index + returns[0][0].length, fn.bodyEnd);
    const end = close(returned.start);
    if (end < 0 || code.slice(end + 1, fn.bodyEnd).trim() !== ';') return null;
    const field = objectField({ start: returned.start, end: end + 1 }, member[2]);
    if (!field) return null;
    const resolved = path(field);
    if (resolved?.path) return null;
    if (resolved?.fixture) return { fixture: true };
    const leaf = leafName(field);
    return leaf && !leaf.split('/').some(part => part === '.' || part === '..')
      && ![...moved.keys()].some(from => posix.basename(from) === posix.basename(leaf)) ? { fixture: true } : null;
  }

  /**
   * A path tail that is mappedWorkingSource's implementationPath or shimPath for one literal identity is the
   * committed path map's own answer, so the read already follows every move and holds no path to repoint. Only the
   * real imported function, an immutable receiver and those two fields qualify; anything else stays unproven.
   */
  function mappedSourceTail(range) {
    const parsed = call(range);
    const tail = parsed ? (operation(parsed, 'path', ['join', 'resolve']) && parsed.args.length > 1 ? parsed.args.at(-1) : null) : range;
    const member = tail && new RegExp(`^(${ID})\\s*\\.\\s*(${ID})$`, 'u').exec(code.slice(tail.start, tail.end));
    if (!member || !MAPPED_SOURCE.fields.includes(member[2])) return false;
    const declared = constant(member[1], tail.start);
    if (!declared || !immutableReceiver(member[1], tail.start, declared)) return false;
    const invoked = call(declared), binding = invoked && !invoked.member ? imported.bindings.get(invoked.name) : null;
    const identity = invoked?.args.length === 2 ? literal(invoked.args[1]) : null;
    return Boolean(binding?.module === 'source' && binding.target === MAPPED_SOURCE.module && binding.imported === MAPPED_SOURCE.name
      && proven(invoked.name, invoked.at) && identity && !identity.includes('${')
      && !identity.split('/').some(part => !part || part === '.' || part === '..'));
  }

  /** Edit only the fs source argument; unsupported source construction never masquerades as success. */
  function sourceArgument(range, reader, regularFile, flowing = new Set()) {
    const argumentsAt = helperArguments(range);
    if (argumentsAt) {
      const key = `${range.start}:${range.end}`;
      if (flowing.has(key) || flowing.size >= 8) { unsupported(range.start, 'recursive local source flow'); return; }
      const before = { edits: edits.length, problems: problems.length, excluded: excluded.length, matched: matchedDataReads.length };
      for (const argument of argumentsAt) sourceArgument(argument, reader, regularFile, new Set([...flowing, key]));
      if (problems.length > before.problems) {
        edits.length = before.edits; problems.length = before.problems; excluded.length = before.excluded; matchedDataReads.length = before.matched;
        unsupported(range.start, 'mixed or unproven local helper arguments');
      }
      return;
    }
    if (regularFile && (disjointSuffix(range) || disjointPathTail(range))) return;
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
    const scalar = imported.bindings.get(code.slice(range.start, range.end));
    if (regularFile && scalar?.module === 'process' && scalar.imported === 'execPath'
      && proven(code.slice(range.start, range.end), range.start)) return;
    const resolved = path(range);
    if (resolved?.fixture) return;
    if (regularFile && factoryField(range)) return;
    if (regularFile && mappedSourceTail(range)) return;
    if (!resolved?.path) {
      const leaf = leafName(range);
      if (regularFile && leaf && !leaf.split('/').some(part => part === '.' || part === '..')
        && ![...moved.keys()].some(from => posix.basename(from) === posix.basename(leaf))) return;
      const data = dataRoot(range);
      if (data) {
        excluded.push(`${file}:${source.slice(0, range.start).split('\n').length}: excluded data read ${code.slice(range.start, range.end).replace(/\s+/gu, '')}: declared as data file ${data}, not a tracked source path`);
        return;
      }
      const declared = matchingDataRead(dataReads, file, source, range);
      if (declared) {
        matchedDataReads.push(declared);
        excluded.push(`${file}:${declared.line}: manifest ${declared.kind} data read ${JSON.stringify(declared.expression)}: ${declared.why}`);
        return;
      }
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
  return { edits, problems: [...new Set(problems)], ...excluded.length ? { excluded } : {}, ...matchedDataReads.length ? { matchedDataReads } : {} };
}

/** Preserve a timed-out compiler as a named refusal through every conservative probe. */
export function fixtureSourceEdits(source, options) {
  try { return fixtureSourceEditsImpl(source, options); }
  catch (error) {
    if (error?.code !== 'CELL_BINDING_TIMEOUT') throw error;
    return { edits: [], problems: [`${options.file}: ${error.message}`] };
  }
}
