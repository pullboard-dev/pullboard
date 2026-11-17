/** @pullboard-test-input source-cell gate */
/** @pullboard-world-pin: clause 2 reads the committed input-coverage source to prove it imports no child-process or disk module. */
/** inputCoverage counts, per cell, the test files that read files and those that declare their inputs [C7,#9800]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inputCoverage } from '../../src/logic/input-coverage.js';

const READS = "import { readFileSync } from 'node:fs';\nreadFileSync('x');\n";
const PURE = "import { test } from 'node:test';\ntest('a', () => {});\n";

test('clause 1: inputCoverage(files) returns per cell the counts tests, readers, declared and undeclared [C7,#9800]', () => {
  const coverage = inputCoverage([
    { path: 'packages/gate/tests/a.test.js', text: READS },
    { path: 'packages/gate/tests/b.test.js', text: `/** @pullboard-test-input source-cell gate */\n${READS}` },
    { path: 'packages/gate/tests/c.test.js', text: PURE },
    { path: 'packages/gate/tests/fixtures/helper.js', text: READS },
    { path: 'packages/spec/tests/d.test.js', text: "// readFileSync(\n" + PURE },
    { path: 'apps/cli/journeys/e.test.js', text: `/** @pullboard-test-input source-tree */\n${READS}` },
  ]);
  assert.deepEqual(coverage, {
    'apps/cli': { tests: 1, readers: 1, declared: 1, undeclared: 0 },
    'packages/gate': { tests: 3, readers: 2, declared: 1, undeclared: 1 },
    'packages/spec': { tests: 1, readers: 0, declared: 0, undeclared: 0 },
  });
  assert.deepEqual(inputCoverage([]), {});
});

test('clause 2: it reads only the file texts it is given and spawns no child process [C7,#9800]', () => {
  const source = readFileSync(new URL('../../src/logic/input-coverage.js', import.meta.url), 'utf8');
  const imports = source.split('\n').filter(line => line.startsWith('import ')).join('\n');
  assert.doesNotMatch(imports, /child_process|node:fs/u);
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//gu, ''), /child_process|spawn(?:Sync)?\(|execFile|execSync/u);
  const given = [{ path: 'packages/nowhere/tests/ghost.test.js', text: READS }];
  assert.equal(inputCoverage(given)['packages/nowhere'].readers, 1);
});

/** Every local file the module reaches through relative import lines, itself included. */
function closure(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(/^(?:import|export)\b[^'"\n]*from '(\.[^']+)'/gmu)) closure(resolve(dirname(file), spec), seen);
  return seen;
}

test('clause 3: input-coverage reaches no io module through its imports, so the io check never runs on load [C7,#10084]', () => {
  const reached = [...closure(fileURLToPath(new URL('../../src/logic/input-coverage.js', import.meta.url)))];
  assert.ok(reached.some(file => file.endsWith('/logic/input-declaration.js')), 'the header rules now live in logic');
  assert.deepEqual(reached.filter(file => /\/gate\/src\/io\//u.test(file)), []);
});
