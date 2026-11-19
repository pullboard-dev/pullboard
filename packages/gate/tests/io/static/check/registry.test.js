/** @pullboard-test-input source-tree */
/** @pullboard-world-pin reads the shipped registry, tree-registry and entry sources to prove submit uses the one list. */
/** Submit's static checks are one registry list, each class run by a function on a tree [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STATIC_CHECKS } from '../../../../heavy.js';

const ROOT = fileURLToPath(new URL('../../../../../..', import.meta.url));

test('gate.io-static-check-registry.one-registry-lists-every-static-check: clause 1: one registry lists every static check class with a function that runs it, and submit reads the registry instead of an inline list [C7]', () => {
  const names = STATIC_CHECKS.map(check => check.name);
  assert.equal(new Set(names).size, names.length, 'each class is listed once');
  for (const expected of ['relay-boundary', 'import-style', 'engine-folder', 'empty-catch', 'file-size', 'test-inputs', 'load-bearing', 'wall-clock-margins', 'test-waits']) {
    assert.ok(names.includes(expected), expected);
  }
  for (const check of STATIC_CHECKS) assert.equal(typeof check.run, 'function', check.name);
  const tree = readFileSync(new URL('../../../../src/io/static/registry.js', import.meta.url), 'utf8');
  for (const expected of ['test-waits', 'cli-launches', 'test-fixtures', 'relay-boundary', 'import-style', 'engine-folder', 'board-write-io', 'prose-commands', 'wall-clock-budgets', 'doctrine']) {
    assert.ok(tree.includes(`name: '${expected}'`), `whole-tree class ${expected}`);
  }
  for (const expected of ['cells', 'cell-lints', 'spec-ids']) {
    assert.ok(tree.includes(`name: '${expected}'`), `stage class ${expected}`);
  }
  const entry = readFileSync(new URL('../../../../../../apps/cli/src/io/static/checks.js', import.meta.url), 'utf8');
  assert.match(entry, /runStaticTreeRegistry\(/u);
  assert.doesNotMatch(entry, /doctrineReport|boardWriteIoProblems/u, 'the submit static command reads the registry, not an inline list');
  // view-pure needs the view app's test roles, so the CLI adds it after the tree registry; gate's registry names no app [V32].
  assert.match(entry, /viewPureGate\(root\)/u, 'the CLI adds the view-pure class beside the registry');
  assert.ok(!tree.includes("name: 'view-pure'"), 'the gate registry names no app class');
  // The import-style class compiles modules with vm.SourceTextModule, which needs the flag, so run the registry in a child.
  const program = `import { runStaticRegistry, changedStaticFailures } from ${JSON.stringify(new URL('../../../../heavy.js', import.meta.url).href)};
const root = ${JSON.stringify(ROOT)};
const context = { root, files: [], staged: false, text: file => (file.endsWith('.json') ? '{}' : ''), previous: () => '', read: file => ({ file, source: '' }), sources: [], engineSources: [] };
const bad = { ...context, sources: [{ file: 'src/x.js', source: "import { a, b } from './y.js';\\n" }] };
process.stdout.write(JSON.stringify({ empty: runStaticRegistry(context), bad: runStaticRegistry(bad),
  self: changedStaticFailures(root, ['packages/gate/src/io/static/check/registry.js']) }));`;
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', program],
    { encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.empty, [], 'an empty change is clean');
  assert.equal(result.bad.length, 1);
  assert.match(result.bad[0], /src\/x\.js:1: one import binding per line \(2 bindings\)/u);
  assert.deepEqual(result.self, [], 'the registry file itself is clean');
  const reader = readFileSync(new URL('../../../../src/io/changed/static.js', import.meta.url), 'utf8');
  assert.match(reader, /runStaticRegistry\(/u);
  assert.doesNotMatch(reader, /relayBoundaryProblems|importStyleViolations|emptyCatchProblems/u, 'the inline list is gone');
});
