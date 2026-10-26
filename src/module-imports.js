/** Parse import edges without evaluating repository code, using V8 rather than a JavaScript grammar guess [V4,C7]. */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lex } from './js-lex.js';

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
function look(sources) {
  // The package parser has an observed stdin/EOF hang. Use a private regular file and bound V8 too.
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-imports-'));
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

/** Every place the whole word import appears, in code or not; Unicode letters count as part of a word. */
const IMPORT = /(?<![\p{ID_Continue}$\u200c\u200d#])import(?![\p{ID_Continue}$\u200c\u200d])/gu;
/** CommonJS loader words, matched with the same identifier boundaries as import. */
const COMMON_JS = /(?<![\p{ID_Continue}$\u200c\u200d#])(?:require|createRequire)(?![\p{ID_Continue}$\u200c\u200d])/gu;
/** Unicode escapes can spell any identifier character, so V8 probes them without decoding source. */
const UNICODE_ESCAPE = /\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]{1,6}\})/gu;

/** Whitespace and comments, which may sit between import, its parenthesis and its argument. A line comment ends at any line terminator. */
const GAP = /^(?:\s|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\/)*/;

/** What a dynamic import of anything but a plain string loads: unknown, so never node: or relative. */
const COMPUTED = '(computed)';

/**
 * The text from `at` on, past whitespace and comments.
 *
 * @param {string} source
 * @param {number} at
 * @returns {string}
 */
function pastGap(source, at) {
  const rest = source.slice(at);
  return rest.slice(GAP.exec(rest)[0].length);
}

/**
 * The bounded string-literal spelling in one confirmed dynamic import, or null for executable expressions.
 * Decoding is deferred so all literals share one compile-only V8 batch.
 *
 * @param {string} source
 * @param {number} at
 * @returns {string | null}
 */
function dynamicLiteralAt(source, at) {
  const argument = pastGap(pastGap(source, at + 'import'.length), 1);
  const literal = /^(['"])(?:\\[\s\S]|(?!\1)[^\\\n\r])*\1/.exec(argument);
  if (!literal) return null;
  const after = pastGap(argument, literal[0].length)[0];
  return after === ')' || after === ',' ? literal[0] : null;
}

/**
 * Every module each source imports. V8 lists the static ones: import and export-from statements and
 * side-effect imports. For each import followed by a parenthesis, V8 also decides two things: a NUL
 * put before the word breaks the module only when the word is code, not text in a string, template,
 * comment or regular expression; and putting 1 in its place still compiles only when the word is a
 * call, not a property name after a dot. Only then is the argument read, and an argument that is not
 * one plain string is reported as COMPUTED, which no rule allows. A method named import, in a class
 * or object, still reads as a call: the scan errs toward a false alarm, never a miss.
 *
 * @param {string[]} sources - Each one a module that compiles.
 * @returns {string[][]}
 */
export function importsIn(sources) {
  const calls = sources.map((source) => [...source.matchAll(IMPORT)].map((match) => match.index).filter((at) => pastGap(source, at + 'import'.length)[0] === '('));
  const variants = sources.flatMap((source, index) =>
    calls[index].flatMap((at) => [`${source.slice(0, at)}\u0000${source.slice(at)}`, `${source.slice(0, at)}1${source.slice(at + 'import'.length)}`]),
  );
  const looks = look([...sources, ...variants]);
  let next = sources.length;
  const edges = sources.map((source, index) => {
    if (!looks[index].compiles) throw new Error('source does not compile as an ES module');
    const dynamic = calls[index].filter(() => {
      const isCode = !looks[next].compiles;
      const isCall = looks[next + 1].compiles;
      next += 2;
      return isCode && isCall;
    });
    return { imports: looks[index].imports, literals: dynamic.map(at => dynamicLiteralAt(source, at)) };
  });
  const literals = [...new Set(edges.flatMap(edge => edge.literals.filter(Boolean)))];
  const decoded = literals.length ? look(literals.map(literal => `import ${literal};`)) : [];
  const values = new Map(literals.map((literal, index) => [literal, decoded[index].imports[0] ?? COMPUTED]));
  return edges.map(edge => [...edge.imports, ...edge.literals.map(literal => values.get(literal) ?? COMPUTED)]);
}

/** Detect actual CommonJS loader words without executing source; invalid modules are conservatively unknown.
 *
 * @param {string[]} sources
 * @returns {boolean[]}
 */
export function commonJsIn(sources) {
  const occurrences = sources.map((source) => [...new Set([
    ...[...source.matchAll(COMMON_JS)].map((match) => match.index),
    ...[...source.matchAll(UNICODE_ESCAPE)].map((match) => match.index),
  ])]);
  const variants = sources.flatMap((source, index) =>
    occurrences[index].map((at) => {
      // Poison after an escape: before a range endpoint, NUL can invalidate a harmless regex range.
      const escaped = /^\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]{1,6}\})/u.exec(source.slice(at));
      const cut = at + (escaped?.[0].length ?? 0);
      return `${source.slice(0, cut)}\u0000${source.slice(cut)}`;
    }),
  );
  const looks = look([...sources, ...variants]);
  let next = sources.length;
  return sources.map((source, index) => {
    if (!looks[index].compiles) return true;
    let found = false;
    for (const _at of occurrences[index]) {
      if (!looks[next].compiles) found = true;
      next += 1;
    }
    return found;
  });
}

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
function quotedProperties(source) {
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
  const parsed = candidates.length ? look(candidates.map(({ literal }) => `import ${literal};`)) : [];
  return new Map(candidates.map((candidate, index) => [candidate.quote,
    { ...candidate, key: parsed[index].compiles ? parsed[index].imports[0] : undefined }]));
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
  if (cache && cache.size < 1024) cache.set(text, value);
  return value;
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
    for (const name of names) {
      const pattern = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const writes = [...code.matchAll(new RegExp(`(?<![\\w$])${pattern}\\s*(?:[+*/%&|^?-]*=(?!=|>)|<<=|>>>=|>>=|\\+\\+|--)`, 'gu'))];
      const initialized = new RegExp(`\\bconst\\s+${pattern}\\s*=`, 'u').test(code);
      const declarations = [...code.matchAll(new RegExp(`\\b(?:const|let|var|function|class)\\s+${pattern}\\b`, 'gu'))];
      const parameters = [...code.matchAll(/(?:function(?:\s+[\w$]+)?\s*|catch\s*)\(([^)]*)\)|\(([^)]*)\)\s*=>|\b([A-Za-z_$][\w$]*)\s*=>/gu)];
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
  return cpuOption(source, bindings.code, quoted, [from, to]);
}

/** Return registration exports for bounded static module-graph propagation, not execution. */
export function cpuRegistrationExportsIn(sources, moduleExports = () => new Set(), literalCache = new Map()) {
  return sources.map((source, index) => cpuBindings(source, name => moduleExports(index, name), false, literalCache).exports);
}

/** Proven callable exports for the same bounded graph; these never confer registration authority. */
export function cpuCallableExportsIn(sources, moduleExports = () => new Set(), literalCache = new Map()) {
  return sources.map((source, index) => cpuBindings(source, name => moduleExports(index, name), true, literalCache).exports);
}

/** Infer CPU load only from options of provenance-recognized test registrations [C7]. */
export function cpuLoadOptionsIn(sources, moduleExports = () => new Set(), callableExports = () => new Set(), literalCache = new Map()) {
  return sources.map((source, index) => {
    const bindings = cpuBindings(source, name => moduleExports(index, name), false, literalCache);
    const quoted = quotedProperties(source);
    const callables = cpuBindings(source, name => callableExports(index, name), true, literalCache).names;
    return cpuCalls(source, bindings).some(args => {
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
