/** @pullboard-test-input source-cell packages/board */
/** Every board-cell test that reads files declares the cells it reads in a header line [C7,U149,#9953]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const READ = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
const CELL_HEADER = /^\/\*\* @pullboard-test-input (?!source-tree \*\/$)\S.* \*\/$/u;
const TREE_HEADER = /^\/\*\* @pullboard-test-input source-tree \*\/$/u;

/** Every test file under the board cell's tests folder, nested folders included. */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? testFiles(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []));
}

/** True when the leading comment lines carry a source-cell header; a source-tree header does not count, it reads every cell. */
function declares(source) {
  for (const line of source.split(/\r?\n/u)) {
    if (CELL_HEADER.test(line)) return true;
    if (TREE_HEADER.test(line)) return false;
    if (!/^\/\*\* @pullboard-/u.test(line)) return false;
  }
  return false;
}

const files = testFiles(DIR).map((file) => ({ file, source: readFileSync(file, 'utf8') }));
const readers = files.filter(({ source }) => READ.test(source));

test('board.inputs.every-test-file-packages-board-tests: clause 1: every test file in packages/board/tests that reads files carries an input header naming the cells it reads, and none names the whole tree [C7,U149]', () => {
  assert.ok(files.length >= 3, 'the scan finds the cell test files');
  const bare = readers.filter(({ source }) => !declares(source)).map(({ file }) => file.slice(DIR.length + 1));
  assert.deepEqual(bare, []);
  const tree = files.filter(({ source }) => source.split(/\r?\n/u).slice(0, 4).some((line) => TREE_HEADER.test(line))).map(({ file }) => file.slice(DIR.length + 1));
  assert.deepEqual(tree, []);
});
