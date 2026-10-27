/** Compile mutations to distinguish actual identifier reads from property spelling, never executing code [CD62,C7]. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** Prepare bounded per-module probes; each unsupported binding keeps its own explicit uncertainty. */
function prepare(source, body, bindings) {
  const result = new Map();
  /** Yield one bounded source mutation group at a time; no repository-wide variant array exists. */
  function* probes() {
    for (const { local } of bindings) {
      if (result.has(local)) continue;
      const row = { reads: [], potentialShadow: false, opaque: null };
      result.set(local, row);
      const escaped = local.replaceAll('$', '\\$');
      const matches = [...body.matchAll(new RegExp(`(?<![\\p{ID_Continue}$])${escaped}(?![\\p{ID_Continue}$])`, 'gu'))];
      // Bound each binding independently before materializing full-source compiler variants.
      if (matches.length > 192 || matches.length * source.length * 4 > 8 * 1024 * 1024) {
        row.opaque = 'binding analysis complexity budget exceeded';
        continue;
      }
      for (const match of matches) {
        const prefix = source.slice(0, match.index), suffix = source.slice(match.index + local.length);
        yield { row, at: match.index, variants: [prefix + '(\n0\n)' + suffix, prefix + local + ':(\n0\n)' + suffix,
          prefix + 'null' + suffix, prefix + '(0)' + suffix] };
      }
    }
  }
  return { result, probes: probes() };
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
  const results = new Map();
  let chunk = [], recipients = [], bytes = 0;
  /** Compile one bounded independent chunk, preserving every original module offset and binding identity. */
  function flush() {
    if (!chunk.length) return;
    const valid = compiles(chunk);
    for (const [index, { row, at }] of recipients.entries()) apply(row, at, valid.slice(index * 4, index * 4 + 4));
    chunk = []; recipients = []; bytes = 0;
  }
  for (const { file, source, body, bindings } of modules) {
    const prepared = prepare(source, body, bindings);
    results.set(file, prepared.result);
    for (const { row, at, variants } of prepared.probes) {
      const size = variants.reduce((sum, value) => sum + value.length, 0);
      if (chunk.length + 4 > 256 || bytes + size > 8 * 1024 * 1024) flush();
      chunk.push(...variants); bytes += size;
      recipients.push({ row, at });
    }
  }
  flush();
  return results;
}
