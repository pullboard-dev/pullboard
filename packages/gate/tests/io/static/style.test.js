/** @pullboard-test-input source-tree */
/** View-owned import formatting follows the lane's two module declarations [C7]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';

/** The import-style test's own time budget: a hang ceiling for compiling the view sources, never a speed claim. */
const TEST_DEADLINE_MS = 120_000;
/** The compile child follows that budget with room to report, so a busy machine slows it but never fails it (#881). */
const COMPILE_LIMIT_MS = TEST_DEADLINE_MS - 10_000;

const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$))*`;
const NAME = String.raw`[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*`;
const NAMED = new RegExp(String.raw`\bimport${GAP}(?:(?<initial>${NAME})${GAP},${GAP})?\{(?<bindings>[^{}]*)\}`, 'dgu');
const NAMESPACE = new RegExp(String.raw`\bimport${GAP}(?<initial>${NAME})${GAP},${GAP}\*${GAP}as${GAP}(?<space>${NAME})`, 'dgu');

/** Find binding starts without counting aliases or commas in quoted exported names twice. */
function bindingStarts(text) {
  const clean = text.replace(/(['"])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\//gu,
    (part) => part.startsWith('/') ? part.replace(/[^\r\n\u2028\u2029]/gu, ' ') : part);
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

/** V8 identifies actual static imports; embedded page text is parsed but never executed. */
function importsSharingLines(sources, { limitMs = COMPILE_LIMIT_MS } = {}) {
  const candidates = sources.map(({ source }) => [
    ...[...source.matchAll(NAMED)].map((match) => ({ at: match.index, starts: [
      ...(match.groups.initial ? [match.indices.groups.initial[0]] : []),
      ...bindingStarts(match.groups.bindings).map((offset) => match.indices.groups.bindings[0] + offset),
    ] })),
    ...[...source.matchAll(NAMESPACE)].map((match) => ({ at: match.index,
      starts: [match.indices.groups.initial[0], match.indices.groups.space[0]] })),
  ]);
  const variants = sources.flatMap(({ source }, index) => candidates[index]
    .map(({ at }) => source.slice(0, at) + '\u0000' + source.slice(at)));
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-view-import-style-'));
  try {
    const input = join(directory, 'sources.json');
    writeFileSync(input, JSON.stringify([...sources.map(({ source }) => source), ...variants]));
    const program = `import vm from 'node:vm';
import { readFileSync } from 'node:fs';
/** Compile only: a NUL breaks an import keyword in code but remains harmless in quoted page text. */
function compiles(source) { try { new vm.SourceTextModule(source); return true; } catch { return false; } }
process.stdout.write(JSON.stringify(JSON.parse(readFileSync(process.argv[1], 'utf8')).map(compiles)));`;
    const child = runFixtureChild(process.execPath,
      ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', program, input],
      { encoding: 'utf8', timeout: limitMs, killSignal: 'SIGKILL', maxBuffer: 2 ** 24 }); // budget: the caller's hang ceiling; no throughput claim.
    if (child.signal === 'SIGKILL' || child.error?.code === 'ETIMEDOUT') throw new Error(`the compile child was stopped after ${child.elapsedMs} ms at its ${limitMs} ms limit`);
    assert.equal(child.status, 0, child.failure ?? child.stderr);
    const compiles = JSON.parse(child.stdout);
    let next = sources.length;
    return sources.flatMap(({ file, source }, index) => {
      assert.equal(compiles[index], true, `${file} compiles`);
      return candidates[index].flatMap(({ starts }) => {
        if (compiles[next++]) return [];
        const lines = new Map();
        for (const at of starts) {
          const line = source.slice(0, at).split(/\r\n|[\n\r\u2028\u2029]/u).length;
          lines.set(line, (lines.get(line) ?? 0) + 1);
        }
        return [...lines].filter(([, bindings]) => bindings > 1).map(([line, bindings]) => ({ file, line, bindings }));
      });
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('the view files import one name per line [C7]', { timeout: TEST_DEADLINE_MS }, () => {
  const sources = [
    { file: 'apps/cli/src/io/cockpit.js', source: readFileSync(new URL('../../../../../apps/cli/src/io/cockpit.js', import.meta.url), 'utf8') },
    { file: 'apps/view/src/io/serve.js', source: readFileSync(new URL('../../../../../apps/view/src/io/serve.js', import.meta.url), 'utf8') },
  ];
  assert.deepEqual(importsSharingLines(sources), [], 'both View-owned files import one binding per line');
  const fixtures = [
    { file: 'same-line', source: "import { first, second as alias } from 'module';" },
    { file: 'mixed', source: "import initial, { first } from 'module';" },
    { file: 'namespace', source: "import initial, * as space from 'module';" },
    { file: 'formatted', source: "import {\n first,\n second as alias,\n} from 'module';" },
    { file: 'page-text', source: "const page = `import { first, second }`; const text = 'import { first, second }'; const regex = /import { first, second }/; /* import { first, second } */" },
    { file: 'quoted-name', source: "import { 'a,b' as one } from 'module';" },
    { file: 'line-comment', source: "import { // comment\u2028 first, second } from 'module';" },
  ];
  assert.deepEqual(importsSharingLines(fixtures), [
    { file: 'same-line', line: 1, bindings: 2 },
    { file: 'mixed', line: 1, bindings: 2 },
    { file: 'namespace', line: 1, bindings: 2 },
    { file: 'line-comment', line: 2, bindings: 2 },
  ]);
});

test('a compile stopped at its limit names the elapsed time and the limit [C7]', { timeout: TEST_DEADLINE_MS }, () => {
  const sources = [{ file: 'large', source: "import { first } from 'module';\n" + 'const value = 1;\n'.repeat(20_000) }];
  assert.throws(() => importsSharingLines(sources, { limitMs: 1 }), /^Error: the compile child was stopped after \d+ ms at its 1 ms limit$/u,
    'a kill says how long the compile ran and what its limit was');
});
