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

/** Prepare bounded per-module probes; each unsupported binding keeps its own explicit uncertainty. */
function prepare(source, body, bindings) {
  const result = new Map();
  const code = lex(source).code, lines = codeLines(source, code);
  /** Yield one bounded source mutation group at a time; no repository-wide variant array exists. */
  function* probes() {
    for (const { local } of bindings) {
      if (result.has(local)) continue;
      const row = { reads: [], potentialShadow: false, opaque: null };
      result.set(local, row);
      const escaped = local.replaceAll('$', '\\$');
      const matches = [...body.matchAll(new RegExp(`(?<![\\p{ID_Continue}$])${escaped}(?![\\p{ID_Continue}$])`, 'gu'))];
      const remaining = matches.filter(match => {
        if (!expressionCall(code, lines, match.index, local.length)) return true;
        row.reads.push(match.index); return false;
      });
      // The original bounds apply to every remaining shadow, write or ambiguous spelling.
      if (remaining.length > 192 || remaining.length * source.length * 4 > 8 * 1024 * 1024) {
        row.opaque = 'binding analysis complexity budget exceeded';
        continue;
      }
      for (const match of remaining) {
        const prefix = source.slice(0, match.index), suffix = source.slice(match.index + local.length);
        yield { row, at: match.index, variants: [prefix + '(\n0\n)' + suffix, prefix + local + ':(\n0\n)' + suffix,
          prefix + 'null' + suffix, prefix + '(0)' + suffix] };
      }
    }
  }
  return { result, probes: probes(), originalValid: false };
}

/** Read only V8-accepted constant/shorthand expressions; declarations, writes and lexical ambiguities stay opaque. */
function apply(row, at, valid) {
  if (valid[0] || valid[1]) row.reads.push(at);
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
    for (const { row, at, offset, original } of recipients) {
      if (original) original.originalValid = valid[offset] === true;
      else apply(row, at, valid.slice(offset, offset + 4));
    }
    chunk = []; recipients = []; bytes = 0;
  }
  for (const { file, source, body, bindings } of modules) {
    const prepared = prepare(source, body, bindings);
    results.set(file, prepared.result);
    preparedModules.push(prepared);
    // Compile the actual original once, including modules whose reads all take the lexical path.
    if (source.length <= 8 * 1024 * 1024) {
      if (chunk.length + 1 > 256 || bytes + source.length > 8 * 1024 * 1024) flush();
      recipients.push({ original: prepared, offset: chunk.length });
      chunk.push(source); bytes += source.length;
    }
    for (const { row, at, variants } of prepared.probes) {
      const size = variants.reduce((sum, value) => sum + value.length, 0);
      if (chunk.length + 4 > 256 || bytes + size > 8 * 1024 * 1024) flush();
      recipients.push({ row, at, offset: chunk.length });
      chunk.push(...variants); bytes += size;
    }
  }
  flush();
  for (const prepared of preparedModules) if (!prepared.originalValid) {
    for (const row of prepared.result.values()) { row.reads = []; row.opaque = 'original module does not compile within the source budget'; }
  }
  return results;
}
