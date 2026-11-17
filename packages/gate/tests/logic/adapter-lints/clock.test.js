/** @pullboard-test-input source-cell gate */
/** The clock lint names a direct Date.now or timer read outside the kernel and holds today's offenders at a ceiling [C7,#9447]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  CLOCK_CEILING_FILE,
  clockLintRows,
} from '../../../src/io/adapter-lints/clock.js';

/** A scratch repo holding `files`, with an optional ceilings file. */
function repo(files, ceilings) {
  const tree = privateFixtureFiles('pb-clocklint-');
  for (const [path, text] of Object.entries(files)) tree.write(path, text);
  if (ceilings) tree.write(CLOCK_CEILING_FILE, JSON.stringify({ version: 1, files: ceilings }));
  return tree.root;
}

test('clause 1: with the setting on, a file outside the kernel reading Date.now and timers fails naming file, line and adapter [C7,#9447]', () => {
  const root = repo({
    'packages/a/src/x.js': 'export const a = 1;\nexport const t = Date.now();\nsetTimeout(() => {}, 5);\n',
    'packages/kernel/src/logic/clock.js': 'export const now = () => Date.now();\n',
  });
  const rows = clockLintRows(root, { enabled: true });
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^packages\/a\/src\/x\.js:2: Date\.now read directly outside the kernel/u);
  assert.match(rows[1], /^packages\/a\/src\/x\.js:3: setTimeout read directly/u);
  assert.ok(rows.every(row => row.includes('use the clock adapter in packages/kernel')));
  assert.ok(rows.every(row => !row.includes('packages/kernel/src')), 'the kernel folder is exempt');
});

test('clause 1: comments, tests and method calls are not direct reads [C7,#9447]', () => {
  const root = repo({
    'packages/a/src/x.js': '// Date.now() is faked\n/** setTimeout( here */\nsocket.setTimeout(5);\n',
    'packages/a/tests/x.test.js': 'Date.now();\n',
  });
  assert.deepEqual(clockLintRows(root, { enabled: true }), []);
});

test('clause 2: offenders at their ceiling pass and a new read in the same file fails; the ceiling never rises [C7,#9447]', () => {
  const files = { 'packages/a/src/x.js': 'Date.now();\nDate.now();\n', 'packages/b/src/y.js': 'Date.now();\n' };
  const root = repo(files, { 'packages/a/src/x.js': 2 });
  const rows = clockLintRows(root, { enabled: true });
  assert.deepEqual(rows.map(row => row.split(':')[0]), ['packages/b/src/y.js'], 'a file past its ceiling (zero for an unlisted file) fails');
  const grown = repo({ 'packages/a/src/x.js': 'Date.now();\nDate.now();\nsetInterval(f, 1);\n' }, { 'packages/a/src/x.js': 2 });
  assert.equal(clockLintRows(grown, { enabled: true }).length, 3);
});

test('clause 2: with the setting off, which is the default, the lint reports nothing [C7,#9447]', () => {
  const root = repo({ 'packages/a/src/x.js': 'Date.now();\n' });
  assert.deepEqual(clockLintRows(root), []);
  assert.deepEqual(clockLintRows(root, { enabled: false }), []);
  assert.deepEqual(clockLintRows(root, { enabled: 'yes' }), []);
});
