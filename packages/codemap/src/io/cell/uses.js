import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { serialize } from 'node:v8';
import { types } from 'node:util';
/** Compile mutations to distinguish actual identifier reads from property spelling, never executing code [CD62,C7]. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lex } from '../../../../kernel/index.js';
import { importsWithCompiler } from '../../../../kernel/index.js';
import { commonJsWithCompiler } from '../../../../kernel/index.js';
import { currentCellLintParser } from './parser.js';
import { availableParallelism } from 'node:os';
import { loadavg } from 'node:os';

const COMPILER = `import vm from 'node:vm'; import {readFileSync} from 'node:fs';
const sources=JSON.parse(readFileSync(process.argv[1],'utf8'));
process.stdout.write(JSON.stringify(sources.map(source=>{try{new vm.SourceTextModule(source);return true;}catch{return false;}})));`;

/** Ask V8 only whether each source compiles; module linking, evaluation and candidate effects are forbidden. */
function compiles(sources) {
  const parser = currentCellLintParser();
  if (parser) return parser(sources).map(row => row.compiles);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-cell-bindings-'));
  try {
    const file = join(directory, 'sources.json');
    writeFileSync(file, JSON.stringify(sources));
    const args = ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', COMPILER, file];
    const run = timeout => spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 2 ** 24, timeout, killSignal: 'SIGKILL' });
    let result = run(10_000);
    if (result.error?.code === 'ETIMEDOUT') {
      const load = loadavg()[0], cores = availableParallelism();
      const timeout = Math.min(120_000, Math.max(30_000, Math.ceil(10_000 * (1 + load / cores))));
      result = run(timeout);
      if (result.error?.code === 'ETIMEDOUT') throw Object.assign(new Error(`cell binding compiler timeout after retry (${timeout} ms; load ${load.toFixed(2)}, ${cores} cores)`), { code: 'CELL_BINDING_TIMEOUT' });
    }
    if (result.status !== 0) throw new Error('cell binding compiler setup failed: ' + (result.error?.message ?? result.stderr));
    return JSON.parse(result.stdout);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Fence every uncertain slash line; a valid regular expression cannot cross any ECMAScript LineTerminator. */
function codeLines(source, code) {
  const lines = [];
  let start = 0;
  for (const match of source.matchAll(/\r\n|[\n\r\u2028\u2029]/gu)) {
    lines.push({ start, end: match.index, slash: code.slice(start, match.index).includes('/') });
    start = match.index + match[0].length;
  }
  lines.push({ start, end: code.length, slash: code.slice(start).includes('/') });
  return lines;
}

/** Prove only call operands in expression grammar; declarations, methods, properties and uncertain regex lines remain probes. */
function expressionCall(code, lines, at, length) {
  let low = 0, high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lines[middle].start <= at) low = middle; else high = middle - 1;
  }
  if (lines[low].slash) return false;
  let before = at - 1, after = at + length;
  while (before >= 0 && /\s/u.test(code[before])) before--;
  while (after < code.length && /\s/u.test(code[after])) after++;
  if (code[after] !== '(') return false;
  if (code[before] === '(') return true;
  if (code[before] === '=') return !/[=<>!+*/%&|^?\-]/u.test(code[before - 1] ?? '');
  return code[before] === '>' && code[before - 1] === '=' && !/[=<>!+*/%&|^?\-]/u.test(code[before - 2] ?? '');
}

/** A qualified member spelling is not the imported identifier; spread operands still read their binding. */
function qualifiedMember(code, at) {
  let before = at - 1;
  while (before >= 0 && /\s/u.test(code[before])) before--;
  return code[before] === '.' && code.slice(before - 2, before + 1) !== '...';
}

/** Prepare bounded per-module probes; each unsupported binding keeps its own explicit uncertainty. */
function prepare(source, body, bindings, scopeBraces = false) {
  const result = new Map();
  const code = lex(source).code, lines = codeLines(source, code);
  const braces = scopeBraces ? lines.filter(line => line.slash).flatMap(line =>
    [...code.slice(line.start, line.end).matchAll(/[{}]/gu)].map(match => line.start + match.index)) : [];
  /** Yield one bounded source mutation group at a time; no repository-wide variant array exists. */
  function* probes() {
    for (const { local } of bindings) {
      if (result.has(local)) continue;
      const row = { reads: [], potentialShadow: false, opaque: null };
      result.set(local, row);
      const escaped = local.replaceAll('$', '\\$');
      const matches = [...body.matchAll(new RegExp(`(?<![\\p{ID_Continue}$])${escaped}(?![\\p{ID_Continue}$])`, 'gu'))];
      const remaining = matches.filter(match => {
        // A qualified property cannot read or declare this identifier; spread still reads its binding.
        if (qualifiedMember(code, match.index)) return false;
        if (!expressionCall(code, lines, match.index, local.length)) return true;
        row.reads.push(match.index); return false;
      });
      // The original bounds apply to every remaining shadow, write or ambiguous spelling.
      if (remaining.length + braces.length > 192 || (remaining.length + braces.length) * source.length * 4 > 8 * 1024 * 1024) {
        row.opaque = 'binding analysis complexity budget exceeded';
        continue;
      }
      // A real code brace accepts a line break; an exposed regex brace cannot accept any raw LineTerminator.
      for (const at of braces) yield { row, at, syntax: true, variants: [source.slice(0, at + 1) + '\n' + source.slice(at + 1)] };
      for (const match of remaining) {
        const prefix = source.slice(0, match.index), suffix = source.slice(match.index + local.length);
        yield { row, at: match.index, qualified: qualifiedMember(code, match.index), variants: [prefix + '(\n0\n)' + suffix, prefix + local + ':(\n0\n)' + suffix,
          prefix + 'null' + suffix, prefix + '(0)' + suffix] };
      }
    }
  }
  return { result, probes: probes(), originalValid: false };
}

/** Read only V8-accepted constant/shorthand expressions; declarations, writes and lexical ambiguities stay opaque. */
function apply(row, at, valid, qualified) {
  if (!qualified && (valid[0] || valid[1])) row.reads.push(at);
  if (!valid[0] && valid[3]) row.opaque = 'ambiguous lexical spelling is not a proven binding read';
  // Possible nested bindings prevent attributing their references to the outer import.
  if (!valid[0] && !valid[1] && !valid[2]) row.potentialShadow = true;
}

const bindingReadScopes = new AsyncLocalStorage();

/** Reuse only real compiler observations inside one explicitly eligible higher-level census. */
export function withBindingReadCache(work, { eligible, observations, warmAll = false, onProbe, runtimeIdentity } = {}) {
  if (runtimeIdentity !== undefined && !/^[a-f0-9]{64}$/u.test(runtimeIdentity)) throw new TypeError('invalid trusted binding runtime identity');
  if (typeof eligible !== 'function') return work();
  const values = observations instanceof Map ? observations : new Map();
  const bytes = [...values.values()].reduce((sum, row) => sum + row.bytes, 0);
  return bindingReadScopes.run({ eligible, values, bytes, warmAll, onProbe, runtimeIdentity }, work);
}

/** Only a durable, eligible census may prepare currently unreachable production modules. */
export function warmAllBindingReads() {
  const scope = bindingReadScopes.getStore();
  return scope?.warmAll === true && reusable(scope);
}

/** An unavailable eligibility observation never authorizes reuse. */
function reusable(scope) {
  try { return scope?.eligible() === true; } catch { return false; }
}

/** Cache only complete plain data; omitted properties, accessors and proxies never supply identity. */
function cacheableModules(modules) {
  const array = value => {
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
    }
    return true;
  };
  const record = (value, keys) => value && !types.isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
      && Object.getOwnPropertyDescriptor(value, key).enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
  return array(modules) && modules.every(row => record(row, ['file', 'source', 'body', 'bindings', 'scopeBraces'])
    && ['file', 'source', 'body', 'bindings'].every(key => Object.hasOwn(row, key))
    && (Object.hasOwn(row, 'scopeBraces') || !('scopeBraces' in row))
    && typeof row.file === 'string' && typeof row.source === 'string' && typeof row.body === 'string'
    && (row.scopeBraces === undefined || typeof row.scopeBraces === 'boolean') && array(row.bindings)
    && row.bindings.every(binding => record(binding, ['local']) && Object.hasOwn(binding, 'local') && typeof binding.local === 'string'));
}

/** Complete actual inputs and runtime context are rechecked after derivation before publication. */
function bindingCacheKey(modules) {
  if (!cacheableModules(modules)) return null;
  try {
    const values = modules.map(row => [row.file, row.source, row.body, row.scopeBraces, row.bindings.map(binding => binding.local)]);
    return 'binding:' + createHash('sha256').update(JSON.stringify([...(bindingReadScopes.getStore()?.runtimeIdentity ? [bindingReadScopes.getStore().runtimeIdentity] : [process.execPath, process.versions.node, process.env.NODE_OPTIONS ?? null]), COMPILER, values])).digest('hex');
  } catch { return null; }
}

/** Reuse immutable per-file export metadata only for exact source and resolved literal edges. */
export function cachedBindingMetadata(source, edges, work) {
  const scope = bindingReadScopes.getStore();
  /** Only plain literal edge values may establish the reusable identity. */
  function identity() {
    if (typeof source !== 'string' || !Array.isArray(edges) || types.isProxy(edges)
      || Object.getPrototypeOf(edges) !== Array.prototype || Reflect.ownKeys(edges).length !== edges.length + 1) return null;
    const rows = [];
    for (let index = 0; index < edges.length; index++) {
      const slot = Object.getOwnPropertyDescriptor(edges, String(index));
      if (!slot || !Object.hasOwn(slot, 'value')) return null;
      const edge = slot.value;
      if (!edge || types.isProxy(edge) || ![Object.prototype, null].includes(Object.getPrototypeOf(edge))) return null;
      const specifier = Object.getOwnPropertyDescriptor(edge, 'specifier'), target = Object.getOwnPropertyDescriptor(edge, 'target');
      if (!specifier || !target || !Object.hasOwn(specifier, 'value') || !Object.hasOwn(target, 'value')
        || typeof specifier.value !== 'string' || typeof target.value !== 'string') return null;
      rows.push([specifier.value, target.value]);
    }
    try { return 'metadata:' + createHash('sha256').update(JSON.stringify([...(scope.runtimeIdentity ? [scope.runtimeIdentity] : [process.execPath, process.versions.node, process.env.NODE_OPTIONS ?? null]), source, rows])).digest('hex'); }
    catch { return null; }
  }
  if (!reusable(scope)) return work();
  const key = identity();
  if (key === null) return work();
  if (scope.values.has(key)) try { return structuredClone(scope.values.get(key).value); }
  catch { scope.bytes -= scope.values.get(key).bytes; scope.values.delete(key); }
  const value = work();
  if (reusable(scope) && key === identity()) try {
    const bytes = Buffer.byteLength(key) + serialize(value).byteLength;
    if (scope.values.size < 32768 && scope.bytes + bytes <= 128 * 1024 * 1024) {
      scope.values.set(key, { value: structuredClone(value), bytes }); scope.bytes += bytes;
    }
  } catch { /* A cache miss remains a normal computation. */ }
  return value;
}

/** Exact ordered probe inputs and runtime context identify a real immutable compiler result. */
export function bindingReadsForModules(modules) {
  const scope = bindingReadScopes.getStore();
  if (!reusable(scope)) { scope?.onProbe?.({ requested: modules.length, computed: modules.length }); return buildBindingReads(modules); }
  if (!cacheableModules(modules) || new Set(modules.map(row => row.file)).size !== modules.length) return buildBindingReads(modules);
  const entries = modules.map(row => ({ row, key: bindingCacheKey([row]) }));
  if (entries.some(entry => entry.key === null)) return buildBindingReads(modules);
  const result = new Map(), missing = [];
  for (const entry of entries) {
    if (scope.values.has(entry.key)) {
      try { result.set(entry.row.file, structuredClone(scope.values.get(entry.key).value)); continue; }
      catch { scope.bytes -= scope.values.get(entry.key).bytes; scope.values.delete(entry.key); }
    }
    missing.push(entry);
  }
  scope.onProbe?.({ requested: modules.length, computed: missing.length });
  if (missing.length) {
    const fresh = buildBindingReads(missing.map(entry => entry.row));
    for (const entry of missing) {
      const value = fresh.get(entry.row.file);
      result.set(entry.row.file, value);
      if (reusable(scope) && entry.key === bindingCacheKey([entry.row])) try {
        const bytes = Buffer.byteLength(entry.key) + serialize(value).byteLength;
        if (scope.values.size < 32768 && scope.bytes + bytes <= 128 * 1024 * 1024) {
          scope.values.set(entry.key, { value: structuredClone(value), bytes }); scope.bytes += bytes;
        }
      } catch { /* Optional memo failure never replaces a real compiler result. */ }
    }
  }
  return new Map(entries.map(({ row }) => [row.file, result.get(row.file)]));
}

/** Batch independent module probes in bounded chunks; never start a compiler child for every module or execute source. */
function buildBindingReads(modules) {
  const results = new Map(), preparedModules = [];
  let chunk = [], recipients = [], bytes = 0;
  /** Compile one bounded independent chunk, preserving every original module offset and binding identity. */
  function flush() {
    if (!chunk.length) return;
    const valid = compiles(chunk);
    for (const { row, at, offset, original, qualified, syntax } of recipients) {
      if (original) original.originalValid = valid[offset] === true;
      else if (syntax) { if (valid[offset] !== true) row.opaque = 'uncertain lexical brace scope'; }
      else apply(row, at, valid.slice(offset, offset + 4), qualified);
    }
    chunk = []; recipients = []; bytes = 0;
  }
  for (const { file, source, body, bindings, scopeBraces } of modules) {
    const prepared = prepare(source, body, bindings, scopeBraces);
    results.set(file, prepared.result);
    preparedModules.push(prepared);
    // Compile the actual original once, including modules whose reads all take the lexical path.
    if (source.length <= 8 * 1024 * 1024) {
      if (chunk.length + 1 > 256 || bytes + source.length > 8 * 1024 * 1024) flush();
      recipients.push({ original: prepared, offset: chunk.length });
      chunk.push(source); bytes += source.length;
    }
    for (const { row, at, variants, qualified, syntax } of prepared.probes) {
      const size = variants.reduce((sum, value) => sum + value.length, 0);
      if (chunk.length + variants.length > 256 || bytes + size > 8 * 1024 * 1024) flush();
      recipients.push({ row, at, qualified, syntax, offset: chunk.length });
      chunk.push(...variants); bytes += size;
    }
  }
  flush();
  for (const prepared of preparedModules) {
    for (const row of prepared.result.values()) {
      if (!prepared.originalValid) { row.reads = []; row.opaque = 'original module does not compile within the source budget'; }
      else row.reads.sort((left, right) => left - right);
    }
  }
  return results;
}

/** Locate literal-aware matching delimiters and argument spans without interpreting candidate expressions. */
function localCallSyntax(source, lexical) {
  const { code, strings, comments } = lexical;
  const hidden = new Map([...strings, ...comments].map(range => [range.start, range.end]));
  const pairs = new Map(), stack = [];
  for (let at = 0; at < code.length; at++) {
    if (hidden.has(at)) { at = hidden.get(at) - 1; continue; }
    const token = code[at];
    if ('([{'.includes(token)) stack.push({ token, at });
    else if (')]}'.includes(token)) {
      const open = stack.pop();
      if (!open || '([{'.indexOf(open.token) !== ')]}'.indexOf(token)) return null;
      pairs.set(open.at, at);
    }
  }
  if (stack.length) return null;
  /** Retain exact source offsets while splitting only outer ordinary call arguments. */
  function argumentsAt(open) {
    const end = pairs.get(open);
    if (end === undefined) return null;
    const args = [];
    let start = open + 1;
    /** Trim surrounding whitespace, never changing an argument's original source coordinates. */
    function append(stop) {
      while (start < stop && /\s/u.test(source[start])) start++;
      while (stop > start && /\s/u.test(source[stop - 1])) stop--;
      if (stop > start) args.push({ start, end: stop });
    }
    for (let at = start; at < end; at++) {
      if (hidden.has(at)) { at = hidden.get(at) - 1; continue; }
      if (pairs.has(at)) { at = pairs.get(at); continue; }
      if (code[at] === ',') { append(at); start = at + 1; }
    }
    append(end);
    if (args.length > 64 || args.some(range => /^\s*\.\.\./u.test(code.slice(range.start, range.end)))) return null;
    return args;
  }
  return { pairs, argumentsAt };
}

/** Return complete direct-call sets only for unique compiler-proven local function declarations; uncertainty grants no authority. */
export function localFunctionCallSets(source, { file } = {}) {
  if (typeof source !== 'string' || source.length > 1024 * 1024) return [];
  const lexical = lex(source), { code } = lexical;
  // Dynamic scope or code construction can observe bindings outside any statically complete call set.
  if (/\b(?:eval|Function)\b/u.test(code)) return [];
  const syntax = localCallSyntax(source, lexical);
  if (!syntax) return [];
  const candidates = [], names = new Map();
  for (const match of code.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const name = match[1], nameAt = match.index + match[0].lastIndexOf(name);
    names.set(name, (names.get(name) ?? 0) + 1);
    let before = match.index - 1;
    while (before >= 0 && /\s/u.test(code[before])) before--;
    // Named expressions, exports and control-statement declarations have no authority in this bounded grammar.
    if (before >= 0 && !';{}'.includes(code[before])) continue;
    const open = match.index + match[0].lastIndexOf('('), close = syntax.pairs.get(open);
    if (close === undefined) continue;
    let body = close + 1;
    while (/\s/u.test(code[body] ?? '') && body < code.length) body++;
    if (code[body] !== '{' || !syntax.pairs.has(body)) continue;
    candidates.push({ name, nameAt, parameterStart: open + 1, parameterEnd: close, bodyStart: body + 1, bodyEnd: syntax.pairs.get(body) });
    if (candidates.length > 64) return [];
  }
  const unique = candidates.filter(row => names.get(row.name) === 1);
  const modules = unique.map(row => ({ file: `${file ?? '<source>'}:local:${row.nameAt}`, source,
    body: code.slice(0, row.nameAt) + ' '.repeat(row.name.length) + code.slice(row.nameAt + row.name.length),
    bindings: [{ local: row.name }], scopeBraces: true }));
  const proof = bindingReadsForModules(modules), result = [];
  for (let index = 0; index < unique.length; index++) {
    const row = unique[index], binding = proof.get(modules[index].file)?.get(row.name);
    if (!binding || binding.opaque || binding.potentialShadow || binding.reads.length > 128) continue;
    const calls = [];
    let complete = true;
    for (const at of binding.reads) {
      let end = at + row.name.length, before = at - 1;
      while (/\s/u.test(code[end] ?? '') && end < code.length) end++;
      while (before >= 0 && /\s/u.test(code[before])) before--;
      const prefix = code.slice(0, before + 1);
      if (code[end] !== '(' || code[before] === '.' || /\bnew\s*$/u.test(prefix)) { complete = false; break; }
      const args = syntax.argumentsAt(end);
      if (!args) { complete = false; break; }
      calls.push({ at, args });
    }
    if (complete) result.push({ ...row, calls });
  }
  return result;
}


/** Prove grammar substitution only: callers must separately reject delete, calls, escapes, shadowing and other mutations. */
export function readOnlyMemberRanges(source, ranges) {
  const accepted = new Set();
  if (typeof source !== 'string' || source.length > 1024 * 1024 || Buffer.byteLength(source, 'utf8') > 1024 * 1024
    || !Array.isArray(ranges) || ranges.length > 128) return accepted;
  const starts = new Set();
  for (const range of ranges) {
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 0 || range.end <= range.start || range.end > source.length || starts.has(range.start)) return accepted;
    starts.add(range.start);
  }
  if (!ranges.length || compiles([source])[0] !== true) return accepted;
  let chunk = [], offsets = [], bytes = 0;
  /** Compile bounded independent replacements; a successful parse is never module linking or evaluation. */
  function flush() {
    if (!chunk.length) return;
    const valid = compiles(chunk);
    for (let index = 0; index < offsets.length; index++) if (valid[index] === true) accepted.add(offsets[index]);
    chunk = []; offsets = []; bytes = 0;
  }
  for (const range of ranges) {
    const variant = source.slice(0, range.start) + '(0)' + source.slice(range.end);
    const size = Buffer.byteLength(variant, 'utf8');
    if (chunk.length + 1 > 256 || bytes + size > 8 * 1024 * 1024) flush();
    chunk.push(variant); offsets.push(range.start); bytes += size;
  }
  flush();
  return accepted;
}

/**
 * The import and CommonJS parsers of one compiler session, for a command that only sees the codemap front door [C7].
 *
 * @param {(source: string) => boolean} compile - The session compiler from withCellLintParser.
 * @returns {{ importsIn: Function, commonJsIn: Function }}
 */
export function cellLintParsers(compile) {
  return { importsIn: sources => importsWithCompiler(sources, compile), commonJsIn: sources => commonJsWithCompiler(sources, compile) };
}
