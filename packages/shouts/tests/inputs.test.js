/** @pullboard-test-input source-cell packages/shouts */
/** The shouts cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9988]. */
/** @pullboard-world-pin: the clauses read the shouts cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/shouts/tests/inputs.test.js';
/** A file read by path: the same calls the gate's reader rule looks for, kept here so the cell imports no other cell. */
const READS = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
const HEADER = /^\/\*\* @pullboard-test-input (.+) \*\/$/u;

/** Every test file under the shouts cell's tests folder, as repo-relative paths. */
function shoutsTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return shoutsTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');
/** The input header lines in a file's leading comment lines, as the text after the tag. */
const headers = source => source.split(/\r?\n/u).slice(0, 5).map(line => line.match(HEADER)?.[1]).filter(Boolean);

test('clause 1: every shouts test file that reads files carries an input header naming the cells it reads [C7,U149]', () => {
  const files = shoutsTests();
  assert.ok(files.includes(SELF) && files.length >= 2, 'the shouts cell has test files to check');
  const undeclared = files.filter(file => READS.test(read(file)) && headers(read(file)).length === 0);
  assert.deepEqual(undeclared, [], 'file readers without a header');
  assert.deepEqual(headers(read(SELF)), ['source-cell packages/shouts'], 'this file names only the shouts cell');
});

test('clause 2: no shouts test declares the whole source tree, and every declared cell is one it can read [C7,U149]', () => {
  for (const file of shoutsTests()) {
    for (const header of headers(read(file))) {
      assert.notEqual(header.trim(), 'source-tree', `${file} declares source-tree`);
      assert.match(header, /^source-cell packages\/[a-z]+(?: packages\/[a-z]+)*$/u, `${file} names cells by path`);
    }
  }
});
