/** Parse import edges without evaluating repository code, using V8 rather than a JavaScript grammar guess [V4,C7]. */
import { spawnSync } from 'node:child_process';
import { importParseScopes } from './cache.js';
import { storedCompilations } from '../parsed.js';
import { foreignNodeOptions } from '../../../../kernel/index.js';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { lex } from '../../../../kernel/index.js';
import { importsWithCompiler } from '../../../../kernel/index.js';
import { commonJsWithCompiler } from '../../../../kernel/index.js';
import { scratchRoot } from '../../../../config/index.js';

/**
 * A child Node that compiles each source in its private input file as an ES module and reports, for each, whether
 * it compiles and the modules it imports statically, as V8 lists them.
 */
const PARSER = [
  "import vm from 'node:vm';",
  "import { readFileSync } from 'node:fs';",
  "const sources = JSON.parse(readFileSync(process.argv[1], 'utf8'));",
  '/** Compile one source without executing repository code. */',
  'const look = (source) => {',
  '  try {',
  '    const module = new vm.SourceTextModule(source);',
  '    return { compiles: true, imports: module.moduleRequests ? module.moduleRequests.map((request) => request.specifier) : module.dependencySpecifiers };',
  '  } catch {',
  '    return { compiles: false, imports: [] };',
  '  }',
  '};',
  'process.stdout.write(JSON.stringify(sources.map(look)));',
].join('\n');

/**
 * What V8 makes of each source, all in one child process.
 *
 * @param {string[]} sources
 * @returns {{ compiles: boolean, imports: string[] }[]}
 */
function compileSources(sources) {
  if (foreignNodeOptions(process.env.NODE_OPTIONS, process.env)) return compileFresh(sources);
  const epoch = JSON.stringify([process.execPath, process.versions.node, process.env.NODE_OPTIONS ?? null, PARSER]);
  return storedCompilations(epoch, sources, compileFresh);
}

/** Compile in a child Node, with no stored result consulted. */
function compileFresh(sources) {
  // The package parser has an observed stdin/EOF hang. Use a private regular file and bound V8 too.
  const cacheDirectory = importParseScopes.getStore()?.directory;
  if (cacheDirectory) mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(cacheDirectory ?? scratchRoot(), 'pullboard-imports-'));
  const input = join(directory, 'sources.json');
  try {
    writeFileSync(input, JSON.stringify(sources), { mode: 0o600 });
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', PARSER, input], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 ** 26, timeout: 10_000, killSignal: 'SIGKILL',
    });
    if (child.status !== 0) throw new Error('V8 import parser failed: ' + (child.error?.message ?? child.stderr));
    return JSON.parse(child.stdout);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const MAX_COMPILED_SOURCE_BYTES = 64 * 1024 * 1024;

/** Copy a private compiler result so callers never receive a mutable cache container. */
function copyCompilation(row) { return { compiles: row.compiles, imports: [...row.imports] }; }

/**
 * Run a sweep with one compile cache, so a source parsed once is never re-compiled by a later pass of the same
 * command. Any NODE_OPTIONS at all turns the cache off, since the preload policy could change what compiles.
 *
 * @template T
 * @param {() => T} work
 * @returns {T}
 */
export function withParseScope(work) {
  if (process.env.NODE_OPTIONS) return work();
  return importParseScopes.run({ directory: importParseScopes.getStore()?.directory, epochs: new Map(), bytes: 0, entries: 0, allowed: () => !process.env.NODE_OPTIONS }, work);
}

/** Compile fresh bytes with real V8, reusing only successful subprocess results in this one scope. */
function look(sources) {
  const scope = importParseScopes.getStore();
  if (!scope || !scope.allowed()) return compileSources(sources);
  const epoch = JSON.stringify([process.execPath, process.versions.node,
    Object.hasOwn(process.env, 'NODE_OPTIONS') ? process.env.NODE_OPTIONS : null,
    '--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', PARSER]);
  if (!scope.epochs.has(epoch)) {
    if (scope.epochs.size >= 8) return compileSources(sources);
    scope.epochs.set(epoch, new Map());
  }
  const cache = scope.epochs.get(epoch);
  const fresh = [...new Set(sources.filter(source => !cache.has(source)))];
  const compiled = fresh.length ? compileSources(fresh) : [];
  if (!Array.isArray(compiled) || compiled.length !== fresh.length || compiled.some(row =>
    typeof row?.compiles !== 'boolean' || !Array.isArray(row.imports) || row.imports.some(value => typeof value !== 'string'))) {
    throw new Error('V8 import parser returned an invalid compile result');
  }
  const observed = new Map();
  for (let index = 0; index < fresh.length; index++) {
    const source = fresh[index];
    const row = Object.freeze({ compiles: compiled[index].compiles, imports: Object.freeze([...compiled[index].imports]) });
    observed.set(source, row);
    const bytes = Buffer.byteLength(source);
    if (scope.entries < 20_000 && scope.bytes + bytes <= MAX_COMPILED_SOURCE_BYTES) {
      cache.set(source, row); scope.bytes += bytes; scope.entries++;
    }
  }
  return sources.map(source => copyCompilation(cache.get(source) ?? observed.get(source)));
}

/** Real V8 compile results for each source, for a caller that wraps the parser to observe what it is asked to parse. */
export const compileModules = look;

/** Whole-word import matching is also used by conservative CPU classification. */
const IMPORT = /(?<![\p{ID_Continue}$\u200c\u200d#])import(?![\p{ID_Continue}$\u200c\u200d])/gu;
/** Skip only ordinary whitespace and comments when classifying executable source. */
const GAP = /^(?:\s|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\/)*/;
/** Read the remaining source after ordinary whitespace and comments. */
function pastGap(source, at) {
  const rest = source.slice(at);
  return rest.slice(GAP.exec(rest)[0].length);
}

/** Read import edges using the caller's compiler or the existing isolated V8 compiler. */
export function importsIn(sources, parse = look) { return importsWithCompiler(sources, parse); }

/** Return compile-only observations for bounded declaration probes; never link or evaluate modules. */
export function moduleCompiles(sources) { return look(sources).map(row => row.compiles); }

/** Detect CommonJS reads using the caller's compiler or the existing isolated V8 compiler. */
export function commonJsIn(sources, parse = look) { return commonJsWithCompiler(sources, parse); }

/** Fail closed for executable module loading or code generation whose registrations are not statically known. */
function opaqueLoadingIn(sources) {
  const occurrences = sources.map(source => [
    ...[...source.matchAll(IMPORT)].filter(match => pastGap(source, match.index + match[0].length).startsWith('(')),
    ...source.matchAll(/(?<![\p{ID_Continue}$\u200c\u200d#])(?:eval|Function)(?![\p{ID_Continue}$\u200c\u200d])/gu),
  ].map(match => match.index));
  const variants = sources.flatMap((source, index) => occurrences[index].map(at =>
    source.slice(0, at) + '\u0000' + source.slice(at)));
  const parsed = look([...sources, ...variants]);
  let next = sources.length;
  return sources.map((source, index) => {
    let found = !parsed[index].compiles || parsed[index].imports.some(name => ['node:vm', 'vm', 'node:module', 'module'].includes(name));
    for (const _at of occurrences[index]) {
      if (!parsed[next].compiles) found = true;
      next += 1;
    }
    return found;
  });
}

/** Decode bounded quoted keys by compiling static imports; repository expressions are never evaluated. */
function quotedPropertyCandidates(source) {
  const candidates = [];
  // Examine each quote independently: a quote in a regex or comment must not hide a later real key.
  for (const quote of source.matchAll(/["']/gu)) {
    const literal = /^(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')/u.exec(source.slice(quote.index))?.[0];
    if (!literal) continue;
    let tail = pastGap(source, quote.index + literal.length);
    if (tail.startsWith(']')) tail = pastGap(tail, 1);
    if (!tail.startsWith(':')) continue;
    const at = source.length - tail.length + 1;
    const value = pastGap(source, at);
    const disabled = /^false\b/u.test(value) && /^[,}]/u.test(pastGap(value, 5));
    candidates.push({ quote: quote.index, literal, at, disabled });
  }
  return candidates;
}

/** Decode apparent property keys through the analysis's exact compile-only literal cache. */
function quotedProperties(source, literalCache) {
  const candidates = quotedPropertyCandidates(source);
  const missing = [...new Set(candidates.map(candidate => candidate.literal).filter(text => !literalCache.has(text)))];
  const parsed = missing.length ? look(missing.map(text => `import ${text};`)) : [];
  const values = new Map(missing.map((text, index) => [text, parsed[index].imports[0] ?? null]));
  for (const [text, value] of values) if (literalCache.size < 1024) literalCache.set(text, value);
  return new Map(candidates.map(candidate => [candidate.quote, { ...candidate,
    key: (literalCache.has(candidate.literal) ? literalCache.get(candidate.literal) : values.get(candidate.literal)) ?? undefined }]));
}

/** Split an executable argument/property list using balanced delimiters, never executing expressions. */
function sourceParts(code, start, closing) {
  const parts = [];
  let begin = start;
  const stack = [];
  for (let at = start; at < code.length; at++) {
    const char = code[at];
    if (!stack.length && char === closing) { parts.push([begin, at]); return { parts, end: at }; }
    if (!stack.length && char === ',') { parts.push([begin, at]); begin = at + 1; }
    else if ('([{'.includes(char)) stack.push({ '(': ')', '[': ']', '{': '}' }[char]);
    else if (')]}'.includes(char)) {
      if (stack.pop() !== char) return null;
    }
  }
  return null;
}

/** Decode import/key spelling through the same V8 reader, without evaluating code. */
function cpuLiteral(text, cache) {
  if (cache?.has(text)) return cache.get(text);
  let value;
  try { value = look([`import ${text};`])[0].imports[0] ?? null; } catch { value = null; }
  // Compilation is pure for these exact bytes. Keep both successful and unknown results bounded
  // to this caller's analysis, never retaining repository source in a process-global cache.
  if (cache && cache.size < 2 * LITERAL_LIMIT) cache.set(text, value);
  return value;
}

/** Most module literals one CPU classification decodes up front, in batches of LITERAL_BATCH per V8 child. */
const LITERAL_LIMIT = 8192;
const LITERAL_BATCH = 512;

/**
 * Decode module literals once; property decoding is needed only at actual registration calls.
 *
 * Every literal of the bounded graph is batched: a literal left out was compiled in its own V8 child on every
 * fixed-point pass, about 500 children and a minute for one named test file (#2425).
 */
export function cpuLiteralCache(sources) {
  const literals = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/(?:\bfrom\s*|\b(?:import|require)\s*\(\s*)/gu)) {
      const literal = /^(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')/u.exec(source.slice(match.index + match[0].length))?.[0];
      if (literal) literals.add(literal);
      if (literals.size >= LITERAL_LIMIT) break;
    }
    if (literals.size >= LITERAL_LIMIT) break;
  }
  const cache = new Map();
  const texts = [...literals];
  for (let at = 0; at < texts.length; at += LITERAL_BATCH) {
    const batch = texts.slice(at, at + LITERAL_BATCH);
    try {
      const parsed = look(batch.map(text => `import ${text};`));
      for (const [index, text] of batch.entries()) cache.set(text, parsed[index].imports[0] ?? null);
    } catch { /* Optional batching cannot replace the existing exact per-literal compilation. */ }
  }
  return cache;
}

/** Read one module's registration bindings; ordinary imported helpers acquire no test authority. */
function cpuBindings(source, moduleExports, callable = false, literalCache) {
  const literalValue = text => cpuLiteral(text, literalCache);
  const lexical = lex(source);
  const code = lexical.code;
  const clean = source.split('');
  for (const { start, end } of lexical.comments) for (let at = start; at < end; at++) {
    if (!'\n\r'.includes(clean[at])) clean[at] = ' ';
  }
  const text = clean.join('');
  const names = new Set();
  const namespaces = new Set();
  const exports = new Set();
  const known = name => name === 'node:test' ? new Set(['default', 'test', 'it', 'describe', 'suite']) : moduleExports(name);
  const word = value => /^["']/u.test(value) ? literalValue(value) : value;
  const pieces = value => value.split(',').map(entry => entry.trim()).filter(Boolean);
  /** Add only bindings whose imported/exported source is a proven registration function. */
  function namedBindings(value, available, add, separator) {
    for (const entry of pieces(value)) {
      const match = separator === ':'
        ? /^([^:]+?)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/u.exec(entry)
        : /^(.+?)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u.exec(entry);
      if (!match) continue;
      const original = word(match[1].trim());
      const local = match[2] ?? original;
      if (available.has(original) && /^[A-Za-z_$][\w$]*$/u.test(local ?? '')) add(local);
    }
  }
  const literal = `(?:"(?:[^"\\\\]|\\\\[\\s\\S])*"|'(?:[^'\\\\]|\\\\[\\s\\S])*')`;
  const declarations = [...text.matchAll(new RegExp(`\\b(import|export)\\s+([^;]*?)\\s+from\\s*(${literal})`, 'gu'))]
    .filter(match => code.slice(match.index, match.index + match[1].length) === match[1]);
  for (const match of declarations) {
    const available = known(literalValue(match[3]));
    const binding = match[2].trim();
    const named = /\{([\s\S]*)\}/u.exec(binding);
    if (match[1] === 'export') {
      if (binding === '*') for (const name of available) if (name !== 'default') exports.add(name);
      if (named) namedBindings(named[1], available, name => exports.add(name), 'as');
      continue;
    }
    if (available.has('default')) {
      const name = /^([A-Za-z_$][\w$]*)(?:\s*,|\s*$)/u.exec(binding)?.[1];
      if (name) { names.add(name); namespaces.add(name); }
    }
    if (named) namedBindings(named[1], available, name => names.add(name), 'as');
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/u.exec(binding)?.[1];
    if (namespace && available.size) namespaces.add(namespace);
  }
  // Literal require/dynamic-import destructuring has the same node:test provenance as a static import.
  for (const match of text.matchAll(new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*(?:await\\s+)?(?:require|import)\\s*\\(\\s*(${literal})\\s*\\)`, 'gu'))) {
    if (!/^(?:const|let|var)\b/u.test(code.slice(match.index))) continue;
    namedBindings(match[1], known(literalValue(match[2])), name => names.add(name), ':');
  }
  const moduleLevel = new Uint8Array(code.length);
  let depth = 0;
  for (let at = 0; at < code.length; at++) {
    moduleLevel[at] = depth === 0 ? 1 : 0;
    if ('([{'.includes(code[at])) depth++;
    else if (')]}'.includes(code[at])) depth--;
  }
  // Callable evidence is separate from registration authority. Only immutable module bindings
  // can prove that an otherwise ambiguous second argument is a callback rather than options.
  if (callable) {
    for (const match of code.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gu)) if (moduleLevel[match.index]) names.add(match[1]);
    for (const match of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*((?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>))/gu)) if (moduleLevel[match.index]) names.add(match[1]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/gu)) {
      if (names.has(match[1]) || callable && !moduleLevel[match.index]) continue;
      const rhs = match[2].trim();
      const alias = /^([A-Za-z_$][\w$]*)\s*$/u.exec(rhs)?.[1];
      const wrapper = /^(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/u.test(rhs)
        && [...names].some(name => new RegExp(`\\b${name}\\s*\\(`, 'u').test(rhs));
      if (names.has(alias) || wrapper && !callable) { names.add(match[1]); changed = true; }
    }
  }
  if (callable) {
    const destructured = new Set();
    const delimiters = [];
    for (let at = 0; at < code.length; at++) {
      const char = code[at];
      if ('([{'.includes(char)) delimiters.push({ char, at });
      else if (')]}'.includes(char)) {
        const opening = delimiters.pop();
        if (!opening || { '(': ')', '[': ']', '{': '}' }[opening.char] !== char) continue;
        if (opening.char !== '(' && /^\s*=(?!=|>)/u.test(code.slice(at + 1))) {
          // Including property keys is deliberately conservative: an ambiguous binding must
          // never inherit a same-spelled function's evidence and hide executable options.
          for (const word of code.slice(opening.at + 1, at).matchAll(/[A-Za-z_$][\w$]*/gu)) destructured.add(word[0]);
        }
      }
    }
    const parameters = [...code.matchAll(/(?:function(?:\s+[\w$]+)?\s*|catch\s*)\(([^)]*)\)|\(([^)]*)\)\s*=>|\b([A-Za-z_$][\w$]*)\s*=>/gu)];
    for (const name of names) {
      const pattern = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const writes = [...code.matchAll(new RegExp(`(?<![\\w$])${pattern}\\s*(?:[+*/%&|^?-]*=(?!=|>)|<<=|>>>=|>>=|\\+\\+|--)`, 'gu'))];
      const initialized = new RegExp(`\\bconst\\s+${pattern}\\s*=`, 'u').test(code);
      const declarations = [...code.matchAll(new RegExp(`\\b(?:const|let|var|function|class)\\s+${pattern}\\b`, 'gu'))];
      const shadowed = parameters.some(match => new RegExp(`\\b${pattern}\\b`, 'u').test(match[1] ?? match[2] ?? match[3] ?? ''));
      if (writes.length > (initialized ? 1 : 0) || declarations.length > 1 || shadowed || destructured.has(name)) names.delete(name);
    }
    // Remove aliases whose original binding was later disqualified as mutable or shadowed.
    const aliasPasses = names.size;
    for (let pass = 0; pass < aliasPasses; pass++) {
      let removed = false;
      for (const match of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/gu)) {
        const alias = /^([A-Za-z_$][\w$]*)\s*$/u.exec(match[2].trim())?.[1];
        if (alias && names.has(match[1]) && !names.has(alias)) { names.delete(match[1]); removed = true; }
      }
      if (!removed) break;
    }
    const defaultFunction = /\bexport\s+default\s+(?:async\s+)?(?:function\s*\(|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/u.test(code)
      || names.has(/\bexport\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(code)?.[1]);
    const defaultName = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;/u.exec(code)?.[1];
    if (defaultFunction || names.has(defaultName)) exports.add('default');
  }
  for (const match of code.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gu)) if (names.has(match[1])) exports.add(match[1]);
  for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}(?!\s*from)/gu)) {
    if (code.slice(match.index, match.index + 6) === 'export') namedBindings(match[1], names, name => exports.add(name), 'as');
  }
  return { code, names, namespaces, exports, moduleLevel, strings: lexical.strings };
}

/** Extract registration calls, including subtests only from a real callback's own context. */
function cpuCalls(source, bindings) {
  const { code, names } = bindings;
  const contexts = new Set(bindings.namespaces);
  const calls = new Map();
  for (let pass = 0; pass < 32; pass++) {
    const before = contexts.size;
    for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)) {
      const name = match[1];
      if (!names.has(name) && !contexts.has(name)) continue;
      if (code.slice(0, match.index).trimEnd().endsWith('.')) continue;
      let at = match.index + name.length;
      while (/\s/u.test(code[at] ?? '') && at < code.length) at++;
      if (code[at] === '.') {
        const member = /^\.\s*([A-Za-z_$][\w$]*)\s*/u.exec(code.slice(at));
        if (!member || !(names.has(name) && ['only', 'skip', 'todo'].includes(member[1])
          || contexts.has(name) && ['test', 'it', 'describe', 'suite', 'default'].includes(member[1]))) continue;
        at += member[0].length;
      } else if (code[at] === '[' && contexts.has(name)) {
        const member = sourceParts(code, at + 1, ']');
        if (!member) continue;
        at = member.end + 1;
        while (/\s/u.test(code[at] ?? '') && at < code.length) at++;
      } else if (!names.has(name)) continue;
      if (code[at] !== '(') continue;
      const parsed = sourceParts(code, at + 1, ')');
      if (!parsed) continue;
      const args = parsed.parts.filter(([from, to]) => source.slice(from, to).trim());
      calls.set(at, args);
      const callback = source.slice(...(args.at(-1) ?? [0, 0]));
      const parameters = /^\s*(?:async\s+)?(?:function(?:\s+[\w$]+)?\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*(?:=>|\{)/u.exec(callback)?.[1];
      if (parameters && parameters !== 'function') contexts.add(parameters);
    }
    if (contexts.size === before) break;
  }
  return [...calls.values()];
}

/** Unknown options at a proven registration stay conservative; unknown ordinary code does not. */
function cpuOption(source, code, quoted, option) {
  if (!option) return false;
  let [from, to] = option;
  while (/\s/u.test(code[from] ?? '') && from < to) from++;
  while (/\s/u.test(code[to - 1] ?? '') && to > from) to--;
  if (code[from] !== '{') return true;
  const object = sourceParts(code, from + 1, '}');
  if (!object || object.end !== to - 1) return true;
  for (const [start, end] of object.parts) {
    const property = pastGap(source.slice(start, end), 0);
    if (!property) continue;
    const key = /^(?:[A-Za-z_$][\w$]*|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')/u.exec(property)?.[0];
    if (!key) return true; // spread/computed/accessor: a real options object may supply cpuLoad.
    const decoded = /^["']/u.test(key) ? quoted.get(end - property.length)?.key : key;
    const tail = pastGap(property, key.length);
    if (decoded === undefined || decoded === '__proto__' || tail && !tail.startsWith(':')) return true;
    if (decoded === 'cpuLoad' && (!tail.startsWith(':') || lex(pastGap(tail, 1)).code.trim() !== 'false')) return true;
  }
  return false;
}

/** Resolve only a single-use immutable module constant in the name-omitted overload. */
function firstCpuOption(source, bindings, quoted, argument) {
  let [from, to] = argument;
  while (/\s/u.test(bindings.code[from] ?? '') && from < to) from++;
  while (/\s/u.test(bindings.code[to - 1] ?? '') && to > from) to--;
  const text = source.slice(from, to);
  if (/^[A-Za-z_$][\w$]*$/u.test(text)) {
    const name = text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const occurrences = [...bindings.code.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'gu'))];
    const declarations = [...bindings.code.matchAll(new RegExp(`\\bconst\\s+${name}\\s*=`, 'gu'))];
    // Any other use may mutate an object or pass it to unknown code. Such a value stays opaque.
    if (occurrences.length === 2 && declarations.length === 1 && bindings.moduleLevel[declarations[0].index]) {
      const declaration = declarations[0];
      let start = declaration.index + declaration[0].length;
      while (/\s/u.test(bindings.code[start] ?? '') && start < bindings.code.length) start++;
      const literal = bindings.strings.find(value => value.start === start);
      const object = bindings.code[start] === '{' ? sourceParts(bindings.code, start + 1, '}') : null;
      const end = object ? object.end + 1 : literal?.end;
      if (end !== undefined && /^(?:[ \t]*[;,\r\n]|\s*$)/u.test(bindings.code.slice(end))) [from, to] = [start, end];
    }
  }
  // A complete string/template is a title; every unresolved expression may instead be options.
  if (bindings.strings.some(value => value.start === from && value.end === to)) return false;
  if (stringConcatenation(bindings, from, to)) return false;
  return cpuOption(source, bindings.code, quoted, [from, to]);
}

/** A string literal joined only by top-level + always evaluates to a string, so it is a title, never options. */
function stringConcatenation(bindings, from, to) {
  const lead = bindings.strings.find(value => value.start === from && value.end < to);
  if (!lead || !/^\s*\+/u.test(bindings.code.slice(lead.end, to))) return false;
  let depth = 0;
  for (let index = lead.end; index < to; index++) {
    const char = bindings.code[index];
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    // A conditional, logical or sequence operator could still yield a non-string value.
    else if (depth === 0 && '?|&,'.includes(char)) return false;
  }
  return depth === 0;
}

/** Return registration exports for bounded static module-graph propagation, not execution. */
export function cpuRegistrationExportsIn(sources, moduleExports = () => new Set(), literalCache = cpuLiteralCache(sources)) {
  return sources.map((source, index) => cpuBindings(source, name => moduleExports(index, name), false, literalCache).exports);
}

/** Proven callable exports for the same bounded graph; these never confer registration authority. */
export function cpuCallableExportsIn(sources, moduleExports = () => new Set(), literalCache = cpuLiteralCache(sources)) {
  return sources.map((source, index) => cpuBindings(source, name => moduleExports(index, name), true, literalCache).exports);
}

/** Infer CPU load only from options of provenance-recognized test registrations [C7]. */
export function cpuLoadOptionsIn(sources, moduleExports = () => new Set(), callableExports = () => new Set(), literalCache = cpuLiteralCache(sources)) {
  return sources.map((source, index) => {
    const bindings = cpuBindings(source, name => moduleExports(index, name), false, literalCache);
    const calls = cpuCalls(source, bindings);
    if (!calls.length) return false;
    const quoted = quotedProperties(source, literalCache);
    const callables = cpuBindings(source, name => callableExports(index, name), true, literalCache).names;
    return calls.some(args => {
      if (!args.length) return false;
      const last = lex(source.slice(...args.at(-1))).code.trim();
      const callback = callables.has(last) || /^(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/u.test(last);
      if (args.length >= 3) return cpuOption(source, bindings.code, quoted, args[1]);
      if (args.length === 2 && callback) return firstCpuOption(source, bindings, quoted, args[0]);
      if (args.length === 2) return cpuOption(source, bindings.code, quoted, args[1]);
      return false;
    });
  });
}
