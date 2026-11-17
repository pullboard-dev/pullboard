/** @pullboard-test-input source-cell packages/config */
/** Every config-cell test that reads files declares the cells it reads in a header line [C7,U149,#9956]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const READ = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
const CELL_HEADER = /^\/\*\* @pullboard-test-input (?!source-tree \*\/$)\S.* \*\/$/u;
const TREE_HEADER = /^\/\*\* @pullboard-test-input source-tree \*\/$/u;
const OTHER = new Set(['// pullboard: browser', '/** @pullboard-test-input test-tree */', '/** @pullboard-test-input docs-tree */']);

/** Every test file under the config cell's tests folder, nested folders included. */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? testFiles(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []));
}

/** True when the leading declaration lines carry a source-cell header; a source-tree header counts only for a file that really reads every cell. */
function declares(source) {
  for (const line of source.split(/\r?\n/u)) {
    if (CELL_HEADER.test(line)) return true;
    if (TREE_HEADER.test(line)) return true;
    if (!OTHER.has(line) && !/^\/\*\* @pullboard-/u.test(line)) return false;
  }
  return false;
}

const readers = testFiles(DIR).map((file) => ({ file, source: readFileSync(file, 'utf8') })).filter(({ source }) => READ.test(source));

test('clause 1: every test file in packages/config/tests that reads files carries an input header naming the cells it reads [C7,U149]', () => {
  assert.ok(readers.length > 0, 'the scan finds the cell test files that read');
  const bare = readers.filter(({ source }) => !declares(source)).map(({ file }) => file.slice(DIR.length + 1));
  assert.deepEqual(bare, []);
});

test('clause 2: with the declared-inputs rule on, no config-cell reader is reported, and a source-tree header stays only on a file that reads every committed source file [C7,U149]', () => {
  const tree = readers.filter(({ source }) => source.split(/\r?\n/u).slice(0, 4).some((line) => TREE_HEADER.test(line))).map(({ file }) => file.slice(DIR.length + 1));
  assert.deepEqual(tree, ['scratch-sites.test.js']);
});
