/** @pullboard-test-input source-tree */
/** Submit's static checks are one registry list, each class run by a function on a tree [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STATIC_CHECKS } from '../packages/gate/index.js';
import { runStaticRegistry } from '../packages/gate/index.js';
import { changedStaticFailures } from '../packages/gate/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('clause 1: one registry lists every static check class with a function that runs it, and submit reads the registry instead of an inline list [C7]', () => {
  const names = STATIC_CHECKS.map(check => check.name);
  assert.equal(new Set(names).size, names.length, 'each class is listed once');
  for (const expected of ['relay-boundary', 'import-style', 'engine-folder', 'empty-catch', 'file-size', 'test-inputs', 'wall-clock-margins', 'test-waits']) {
    assert.ok(names.includes(expected), expected);
  }
  for (const check of STATIC_CHECKS) assert.equal(typeof check.run, 'function', check.name);
  const context = { root: ROOT, files: [], staged: false, text: () => '', previous: () => '', read: file => ({ file, source: '' }), sources: [], engineSources: [] };
  assert.deepEqual(runStaticRegistry(context), [], 'an empty change is clean');
  const bad = { ...context, sources: [{ file: 'src/x.js', source: "import { a, b } from './y.js';\n" }] };
  const failures = runStaticRegistry(bad);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /src\/x\.js:1: one import binding per line \(2 bindings\)/u);
  assert.deepEqual(changedStaticFailures(ROOT, ['packages/gate/src/shell/static-check-registry.js']), [], 'the registry file itself is clean');
  const reader = readFileSync(new URL('../packages/gate/src/shell/changed-static.js', import.meta.url), 'utf8');
  assert.match(reader, /runStaticRegistry\(/u);
  assert.doesNotMatch(reader, /relayBoundaryProblems|importStyleViolations|emptyCatchProblems/u, 'the inline list is gone');
});
