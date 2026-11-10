/** Check actual static import binding lines without mistaking embedded source text for code [C7]. */
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFixtureChild } from './child.js';

const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$))*`;
const IDENTIFIER = String.raw`[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*`;
const NAMED = new RegExp(String.raw`\bimport${GAP}(?:(?<default>${IDENTIFIER})${GAP},${GAP})?\{(?<bindings>[^{}]*)\}`, 'dgu');
const NAMESPACE = new RegExp(String.raw`\bimport${GAP}(?<default>${IDENTIFIER})${GAP},${GAP}\*${GAP}as${GAP}(?<namespace>${IDENTIFIER})`, 'dgu');

/** Keep line positions while removing comments inside an import's binding list. */
function withoutComments(text) {
  return text.replace(/(['"])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\//gu,
    (part) => part.startsWith('/') ? part.replace(/[^\r\n\u2028\u2029]/gu, ' ') : part);
}

/** Read binding starts, treating quoted exported names and aliases as one binding each. */
function bindingOffsets(text) {
  const clean = withoutComments(text);
  const starts = [];
  let start = 0;
  let quote = null;
  for (let index = 0; index <= clean.length; index++) {
    const character = clean[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ',' || index === clean.length) {
      const first = /\S/u.exec(clean.slice(start, index));
      if (first) starts.push(start + first.index);
      start = index + 1;
    }
  }
  return starts;
}

/** Let V8 distinguish code imports from the same words inside comments, strings, templates or regexes. */
export function importStyleViolations(sources) {
  const candidates = sources.map(({ source }) => [
    ...[...source.matchAll(NAMED)].map((match) => ({ at: match.index, offsets: [
      ...(match.groups.default ? [match.indices.groups.default[0]] : []),
      ...bindingOffsets(match.groups.bindings).map((offset) => match.indices.groups.bindings[0] + offset),
    ] })),
    ...[...source.matchAll(NAMESPACE)].map((match) => ({ at: match.index,
      offsets: [match.indices.groups.default[0], match.indices.groups.namespace[0]] })),
  ]);
  const variants = sources.flatMap(({ source }, index) => candidates[index]
    .map(({ at }) => source.slice(0, at) + '\u0000' + source.slice(at)));
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-import-style-'));
  const input = join(directory, 'sources.json');
  try {
    writeFileSync(input, JSON.stringify([...sources.map(({ source }) => source), ...variants]));
    const program = `import vm from 'node:vm';
import { readFileSync } from 'node:fs';
/** Compile syntax without linking or running repository source. */
function compiles(source) { try { new vm.SourceTextModule(source); return true; } catch { return false; } }
process.stdout.write(JSON.stringify(JSON.parse(readFileSync(process.argv[1], 'utf8')).map(compiles)));`;
    const child = runFixtureChild(process.execPath,
      ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', program, input],
      { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 2 ** 24 });
    if (child.status !== 0) throw new Error(child.failure ?? child.stderr);
    const compiles = JSON.parse(child.stdout);
    let next = sources.length;
    return sources.flatMap(({ file, source }, index) => {
      if (!compiles[index]) throw new Error(`${file}: source does not compile`);
      return candidates[index].flatMap(({ offsets }) => {
        if (compiles[next++]) return [];
        const lines = new Map();
        for (const offset of offsets) {
          const line = source.slice(0, offset).split(/\r\n|[\n\r\u2028\u2029]/u).length;
          lines.set(line, (lines.get(line) ?? 0) + 1);
        }
        return [...lines].filter(([, count]) => count > 1).map(([line, count]) => ({ file, line, count }));
      });
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
