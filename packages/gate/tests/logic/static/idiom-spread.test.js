/** @pullboard-test-input source-cell gate */
/** @pullboard-world-pin reads the seeded idiom ceilings file in the gate cell to prove its ceiling only falls from 6 sites [C7,#9521]. */
/** The idiom-spread check names a statement shape copied into 3 or more files and holds a named idiom at a ceiling that only falls [C7,#9521]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  IDIOM_CEILING_FILE,
  idiomSpreadRows,
  normalizeLine,
  shapesOf,
} from '../../../src/io/adapter-lints/idiom-spread.js';

/** A three-line statement whose only difference between copies is the string and number it carries. */
const copy = (name, count) => [
  `const rows = listRows(board, '${name}', { limit: ${count} });`,
  'const names = rows.map(row => row.name).filter(Boolean).sort();',
  'if (!names.length) throw new Error("no rows to show");',
  '',
].join('\n');

/** Source rows for a checkout of the given files. */
const rowsOf = files => Object.entries(files).map(([file, source]) => ({ file, source }));

test('clause 1: with the setting on, a 3-line statement shape found in 3 files fails naming every file, and 2 files pass [C7,#9521]', () => {
  const three = rowsOf({
    'packages/a/src/one.js': 'export const one = 1;\n' + copy('a', 1),
    'packages/b/src/two.js': copy('b', 2),
    'apps/c/src/three.js': 'import { x } from "./x.js";\n' + copy('c', 3),
  });
  const found = idiomSpreadRows(three, { enabled: true });
  assert.equal(found.length, 3, 'one row per file, overlapping windows of one copy report once');
  for (const file of ['packages/a/src/one.js', 'packages/b/src/two.js', 'apps/c/src/three.js']) {
    assert.ok(found.some(row => row.startsWith(file + ':')), file);
  }
  assert.match(found.find(row => row.startsWith('packages/a/src/one.js:')), /^packages\/a\/src\/one\.js:2: statement shape .* is copied into 3 files with no shared helper; extract one$/u);
  assert.deepEqual(idiomSpreadRows(three.slice(0, 2), { enabled: true }), [], 'two files are not a spread');
});

test('clause 1: imports, comments, tests and short or closing-only windows are not shapes [C7,#9521]', () => {
  const same = 'import { a } from "./a.js";\nimport { b } from "./b.js";\nimport { c } from "./c.js";\n// a comment line\n// another comment line\n';
  const closers = '}\n}\n});\n';
  const rows = rowsOf({
    'packages/a/src/one.js': same + closers + copy('a', 1),
    'packages/b/src/two.js': same + closers,
    'packages/c/src/three.js': same + closers,
    'packages/d/tests/four.test.js': copy('d', 4),
  });
  assert.deepEqual(idiomSpreadRows(rows, { enabled: true }), []);
  assert.equal(normalizeLine('  import { a } from "./a.js";'), null);
  assert.equal(normalizeLine('  const x = foo("hello", 42);'), 'const x = foo(S, N);');
  assert.equal(shapesOf('a();\nb();\nc();\n').size, 0, 'a window under the length floor is not a shape');
});

test('clause 2: the requestAnimationFrame plus setTimeout idiom is seeded at 6 sites in 3 files; a 7th site fails and the ceiling file only holds a falling number [C7,#9521]', () => {
  const ceilings = JSON.stringify({ version: 1, idioms: { frame: { pattern: 'requestAnimationFrame\\(\\(\\) => setTimeout\\(', sites: 6 } } });
  const site = n => `  requestAnimationFrame(() => setTimeout(() => { later${n}(); }, 0));\n`;
  const files = {
    'apps/view/src/io/page/actions.js': site(1) + site(2) + site(3),
    'apps/view/src/io/page/render.js': site(4) + site(5),
    'apps/view/src/io/page/menu.js': site(6),
  };
  assert.deepEqual(idiomSpreadRows(rowsOf(files), { enabled: true, ceilings }), [], 'six sites in three files sit at the ceiling');
  const grown = rowsOf({ ...files, 'apps/view/src/io/page/menu.js': site(6) + site(7) });
  const found = idiomSpreadRows(grown, { enabled: true, ceilings });
  assert.equal(found.length, 7, 'every site is named once the count passes the ceiling');
  assert.ok(found.every(row => /idiom frame has 7 sites, ceiling 6/u.test(row)));
  assert.equal(IDIOM_CEILING_FILE, 'packages/gate/data/ceilings/idiom-spread.json');
  const seeded = JSON.parse(readFileSync(join(import.meta.dirname, '../../../data/ceilings/idiom-spread.json'), 'utf8')).idioms['request-animation-frame-set-timeout'];
  assert.ok(seeded.sites <= 6, 'a ceiling may only fall from the 6 sites seeded');
  const real = new RegExp(seeded.pattern, 'u');
  assert.ok(real.test('requestAnimationFrame(() => setTimeout(then, 0));'));
  assert.ok(real.test('(typeof requestAnimationFrame === "function" ? requestAnimationFrame : (next) => next())(() => setTimeout(() => {'));
  assert.ok(!real.test('itemsWindowFrame = (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (next) => setTimeout(next, 0))(() => { x(); });'));
});

test('clause 3: with gate.idiomSpread off, which is the default, the check reports nothing [C7,#9521]', () => {
  const rows = rowsOf({ 'packages/a/src/one.js': copy('a', 1), 'packages/b/src/two.js': copy('b', 2), 'packages/c/src/three.js': copy('c', 3) });
  assert.deepEqual(idiomSpreadRows(rows), []);
  assert.deepEqual(idiomSpreadRows(rows, { enabled: false }), []);
  assert.deepEqual(idiomSpreadRows(rows, { enabled: 'yes' }), []);
});
