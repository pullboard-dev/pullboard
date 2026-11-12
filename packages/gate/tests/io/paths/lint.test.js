/** The path lint finds repository paths in code that do not exist, and the ratchet lets the count only fall [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import {
  missingPathFindings,
  missingPathGrowth,
} from '../../../src/io/paths/lint.js';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';

/** Source text of the quoted segments, so a fixture can hold a segment-built join without this file holding one. */
const quoted = (...parts) => parts.map(part => `'${part}'`).join(', ');

/** Run the lint over a scratch repo of `files` whose only rename map is `map`. */
function lint(files, map = {}) {
  const tree = privateFixtureFiles('pb-pathlint-');
  for (const [path, text] of Object.entries(files)) tree.write(path, text);
  return missingPathFindings(tree.root, { map });
}

test('clause 1: new URL anchored on import.meta.url to a missing file is a finding with file:line [C7]', () => {
  const found = lint({
    'packages/a/src/x.js': "import { x } from './y.js';\nconst gone = new URL('../data/gone.json', import.meta.url);\n",
    'packages/a/src/y.js': 'export const x = 1;\n',
  });
  assert.deepEqual(found.map(row => `${row.file}:${row.line}:${row.path}`), ['packages/a/src/x.js:2:packages/a/data/gone.json']);
});

test('clause 1: an existing target is no finding, in new URL, join and resolve [C7]', () => {
  const found = lint({
    'packages/a/src/x.js': `const a = new URL('../data/here.json', import.meta.url);
const b = join(import.meta.dirname, '..', 'data', 'here.json');
const c = resolve(dirname(fileURLToPath(import.meta.url)), '../data/here.json');\n`,
    'packages/a/data/here.json': '{}\n',
  });
  assert.deepEqual(found, []);
});

test('clause 1: join on dirname(fileURLToPath(import.meta.url)) and import.meta.dirname find missing targets [C7]', () => {
  const found = lint({
    'packages/a/src/x.js': `const a = join(dirname(fileURLToPath(import.meta.url)), '..', 'nope.js');
const b = resolve(import.meta.dirname, 'also', 'nope.js');\n`,
  });
  assert.deepEqual(found.map(row => `${row.line}:${row.path}`), ['1:packages/a/nope.js', '2:packages/a/src/also/nope.js']);
});

test('clause 1: segment-built paths on a repo-root variable and array path pieces are findings [C7]', () => {
  const found = lint({
    'packages/a/src/x.js': `const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const a = join(REPO_ROOT, ${quoted('packages', 'gate', 'src', 'old.js')});
const pieces = ['packages', 'gate', 'src', 'old2.js'];\n`,
  });
  assert.deepEqual(found.map(row => `${row.line}:${row.path}`), ['2:packages/gate/src/old.js', '3:packages/gate/src/old2.js']);
});

test('clause 1: a missing path that is a path-map key suggests the new path, following chains [C7]', () => {
  const found = lint({
    'packages/a/src/x.js': `const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');\nconst a = join(REPO_ROOT, ${quoted('src', 'old.js')});\n`,
    'packages/z/new.js': '\n',
  }, { 'src/old.js': 'packages/z/mid.js', 'packages/z/mid.js': 'packages/z/new.js' });
  assert.equal(found.length, 1);
  assert.equal(found[0].suggest, 'packages/z/new.js');
});

test('clause 1: fixture text written into scratch repos and prefix checks are not findings [C7]', () => {
  const found = lint({
    'packages/a/tests/x.test.js': `tree.write('a.js', "const g = new URL('../data/gone.json', import.meta.url);");
const text = \`join(import.meta.dirname, 'nope.js')\`;
if (spec.startsWith('../')) return;
writeFileSync(join(import.meta.dirname, 'out', 'made.txt'), 'x');\n`,
  });
  assert.deepEqual(found, []);
});

test('clause 1: the ratchet fails only for files over their recorded count, and counts only fall [C7]', () => {
  const rows = [{ file: 'a.js', line: 3, path: 'x/y.js', suggest: null }, { file: 'a.js', line: 4, path: 'x/z.js', suggest: 'q/z.js' }];
  assert.deepEqual(missingPathGrowth(rows, { files: { 'a.js': 2 } }), []);
  assert.deepEqual(missingPathGrowth(rows.slice(0, 1), { files: { 'a.js': 2 } }), []);
  const grown = missingPathGrowth(rows, { files: { 'a.js': 1 } });
  assert.equal(grown.length, 1);
  assert.match(grown[0], /^a\.js:4: .*x\/z\.js.*q\/z\.js/u);
  assert.equal(missingPathGrowth(rows, { files: {} }).length, 2);
});

test('clause 1: the missing-paths class is registered as a static tree check [C7]', () => {
  assert.ok(STATIC_TREE_CHECKS.some(check => check.name === 'missing-paths'));
});
