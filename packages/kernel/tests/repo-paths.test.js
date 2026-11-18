/** @pullboard-test-input source-cell apps/cli packages/doctrine packages/gate packages/kernel */
/** @pullboard-world-pin reads every tracked source file to prove none builds a repository path from root segments [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoPath } from '../light.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ROOT_SEGMENTS = new Set(['bin', 'src', 'test', 'relay']);

/** Files allowed to pass a root segment followed by more segments, each with the reason. */
const EXCEPTIONS = new Map([
  ['packages/doctrine/tests/hooks.test.js', 'spawns the CLI; naming apps/cli/pullboard.js as one string makes the cell-test ratchet count it as a new finding, so the coordinator moves it to the journeys'],
  ['docs/shots/demo.mjs', 'docs lane owns it; the core lane cannot edit it, so the coordinator converts it in the freeze'],
  ['docs/shots/video.mjs', 'docs lane owns it; the core lane cannot edit it, so the coordinator converts it in the freeze'],
  ['apps/cli/journeys/verify/item/panel.test.js', 'view lane owns it; the core lane cannot edit it, so the coordinator converts it in the freeze'],
  ['apps/cli/tests/fixtures/cockpit/machine.js', 'view lane owns it; the core lane cannot edit it, so the coordinator converts it in the freeze'],
  ['apps/cli/tests/fixtures/cockpit/perf/generate.mjs', 'view lane owns it; the core lane cannot edit it, so the coordinator converts it in the freeze'],
  ['apps/cli/tests/fixtures/cockpit/perf/run.mjs', 'view lane owns it; the core lane cannot edit it, so the coordinator converts it in the freeze'],
  ['apps/cli/journeys/shout/prose.test.js', 'view lane owns it; the core lane cannot edit it, so the coordinator converts it in the freeze'],
  ['apps/cli/journeys/init/provenance.test.js', 'view lane owns it; the core lane cannot edit it, so the coordinator converts it in the freeze'],
  ['apps/cli/journeys/relay/cockpit.test.js', 'view lane owns it; the core lane cannot edit it, so the coordinator converts it in the freeze'],
  ['apps/view/tests/needs-door.test.js', 'view lane owns it; the core lane cannot edit it, so the coordinator converts it in the freeze'],
]);

/** The index just past a quoted string or template literal that starts at `at`, or -1. */
function skipQuoted(text, at) {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === '\\') i += 1;
    else if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') depth -= 1;
        else if (text[i] === "'" || text[i] === '"' || text[i] === '`') { i = skipQuoted(text, i); continue; }
        i += 1;
      }
      continue;
    }
    if (quote !== '`' && text[i] === '\n') return -1;
    i += 1;
  }
  return i < text.length ? i + 1 : -1;
}

/** The top-level arguments of the call whose open parenthesis is at `open`, as source text; null when it does not parse. */
function callArguments(text, open) {
  const args = [];
  let start = open + 1, depth = 0, i = start;
  while (i < text.length) {
    const char = text[i];
    if (char === "'" || char === '"' || char === '`') { i = skipQuoted(text, i); if (i < 0) return null; continue; }
    if (char === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (char === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i); if (i < 0) return null; i += 2; continue; }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) { args.push(text.slice(start, i)); return args; }
      depth -= 1;
    } else if (char === ',' && depth === 0) { args.push(text.slice(start, i)); start = i + 1; }
    i += 1;
  }
  return null;
}

/** Every join( or resolve( call that passes a bare root segment followed by more arguments, as `file:line`. */
function segmentBuiltCalls(file, text) {
  const found = [];
  for (const call of text.matchAll(/\b(?:join|resolve)\(/gu)) {
    const args = callArguments(text, call.index + call[0].length - 1);
    if (!args) continue;
    const bare = args.slice(0, -1).findIndex(arg => /^\s*(['"`])(?:bin|src|test|relay)\1\s*$/u.test(arg));
    if (bare >= 0) found.push(`${file}:${text.slice(0, call.index).split('\n').length}`);
  }
  return found;
}

test('kernel.repo-paths.repo-path-joins-under-the-root: repoPath joins a slash-separated repository path under the root [C7]', () => {
  assert.equal(repoPath('/work/repo', 'packages/gate/data/ceilings/cells-edges.json'), join('/work/repo', 'packages', 'gate', 'data', 'ceilings', 'cells-edges.json'));
  assert.equal(repoPath('/work/repo', 'src'), `/work/repo${sep}src`);
  assert.equal(repoPath('/work/repo', 'src/'), `/work/repo${sep}src`);
  assert.equal(repoPath('/work/repo', 'test/a b/c.test.js'), join('/work/repo', 'test', 'a b', 'c.test.js'));
});

test('kernel.repo-paths.the-scan-finds-a-root-segment: the scan finds a root segment followed by more segments and nothing else [C7]', () => {
  const sample = [
    "join(root, 'bin', 'checks', x)",
    "path.resolve(root,\n  'src',\n  `${name}.js`)",
    "join(root, 'bin')",
    "join(root, 'packages', 'bin-tools', 'x.js')",
    "repoPath(root, 'bin/checks/x.json')",
  ].join('\n');
  assert.deepEqual(segmentBuiltCalls('sample.js', sample), ['sample.js:1', 'sample.js:2']);
});

test('kernel.repo-paths.no-tracked-js-builds-a-repository-path: no tracked .js builds a repository path from a root segment followed by more segments [C7]', () => {
  const tracked = execFileSync('git', ['ls-files', '*.js', '*.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean);
  const found = [];
  for (const file of tracked) {
    if (EXCEPTIONS.has(file) || file === 'packages/kernel/tests/repo-paths.test.js') continue;
    let text;
    try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
    found.push(...segmentBuiltCalls(file, text));
  }
  assert.deepEqual(found, [], 'name the file by one repository-relative string: join(root, \'bin/checks/x.json\') or repoPath(root, `src/${name}`)');
});
