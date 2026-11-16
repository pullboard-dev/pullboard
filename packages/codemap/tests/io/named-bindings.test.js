/** @pullboard-test-loads packages/codemap/src/io/module/names.js */
/** A module's named imports and re-exports are read without running it, and anything else is unresolved, never dropped [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namedBindingsIn } from '../../src/io/module/names.js';

test('clause 1: named imports and named re-exports are returned, star imports and star re-exports are unresolved [C7]', () => {
  const [found] = namedBindingsIn([[
    "import { alpha, beta as b } from './one.js';",
    "export { gamma, delta as d, default as e } from './two.js';",
    "import * as everything from './three.js';",
    "export * from './four.js';",
    "export * as spaced from './five.js';",
    "const text = \"import { hidden } from './nope.js'\"; // export { gone } from './nope.js'",
    'const local = 1; export { local };',
  ].join('\n')]);
  assert.deepEqual(found.imports, [{ source: './one.js', names: [{ imported: 'alpha', local: 'alpha' }, { imported: 'beta', local: 'b' }] }]);
  assert.deepEqual(found.reexports, [{ source: './two.js', names: [
    { imported: 'gamma', exported: 'gamma' }, { imported: 'delta', exported: 'd' }, { imported: 'default', exported: 'e' }] }]);
  assert.deepEqual(found.unresolved, [
    { kind: 'namespace', source: './three.js' },
    { kind: 'star-reexport', source: './four.js' },
    { kind: 'namespace-reexport', source: './five.js' },
  ]);
});

test('clause 2: default, namespace and dynamic imports and a malformed export list are unresolved, never dropped [C7]', () => {
  const [mixed, broken] = namedBindingsIn([
    [
      "import first, { second } from './default.js';",
      "import * as space from './space.js';",
      "const later = await import('./dynamic.js');",
      "const computed = await import('./' + later.name);",
      "export { second as \"quoted name\" } from './quoted.js';",
      "import './bare.js';",
    ].join('\n'),
    "export { a b } from './broken.js';",
  ]);
  assert.deepEqual(mixed.imports, [{ source: './default.js', names: [{ imported: 'second', local: 'second' }] }]);
  assert.deepEqual(mixed.reexports, []);
  assert.deepEqual(mixed.unresolved, [
    { kind: 'default', source: './default.js' },
    { kind: 'namespace', source: './space.js' },
    { kind: 'dynamic', source: './dynamic.js' },
    { kind: 'dynamic', source: null },
    { kind: 'malformed', source: './quoted.js' },
    { kind: 'bare', source: './bare.js' },
  ]);
  assert.deepEqual(broken, { imports: [], reexports: [], unresolved: [{ kind: 'malformed', source: './broken.js' }] });
});
