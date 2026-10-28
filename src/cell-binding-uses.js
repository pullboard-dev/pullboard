/** Compile mutations to distinguish actual identifier reads from property spelling, never executing code [CD62,C7]. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lex } from '../packages/kernel/index.js';

const COMPILER = `import vm from 'node:vm'; import {readFileSync} from 'node:fs';
const sources=JSON.parse(readFileSync(process.argv[1],'utf8'));
process.stdout.write(JSON.stringify(sources.map(source=>{try{new vm.SourceTextModule(source);return true;}catch{return false;}})));`;

/** Ask V8 only whether each source compiles; module linking, evaluation and candidate effects are forbidden. */
function compiles(sources) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-cell-bindings-'));
  try {
    const file = join(directory, 'sources.json');
    writeFileSync(file, JSON.stringify(sources));
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', COMPILER, file],
      { encoding: 'utf8', maxBuffer: 2 ** 24, timeout: 10_000, killSignal: 'SIGKILL' });
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

/** Batch independent module probes in bounded chunks; never start a compiler child for every module or execute source. */
export function bindingReadsForModules(modules) {
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
