/** @pullboard-test-input source-cell packages/sync */
/** The sync cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9994]. */
/** @pullboard-world-pin: the clauses read the sync cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/sync/tests/inputs.test.js';
/** A file read by path: the same calls the gate's reader rule looks for, kept here so this cell imports no other cell. */
const READS = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
const HEADER = /^\/\*\* @pullboard-test-input (.+) \*\/$/u;

/** Every test file under the sync cell's tests folder, as repo-relative paths. */
function syncTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return syncTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');
/** The input header lines that open a file, as the text after the tag; the first other line ends them, as the gate reads them. */
function headers(source) {
  const found = [];
  for (const line of source.split(/\r?\n/u)) {
    const text = line.match(HEADER)?.[1];
    if (!text) break;
    found.push(text);
  }
  return found;
}

test('clause 1: every sync test file that reads files carries an input header naming what it reads [C7,U149]', () => {
  const files = syncTests();
  assert.ok(files.includes(SELF) && files.length >= 2, 'the sync cell has test files to check');
  const undeclared = files.filter(file => READS.test(read(file)) && headers(read(file)).length === 0);
  assert.deepEqual(undeclared, [], 'file readers without a header');
  assert.deepEqual(headers(read(SELF)), ['source-cell packages/sync'], 'this file names only the sync cell');
});

test('clause 1: no sync test declares the whole source tree, and a cell header names cells by path [C7,U149]', () => {
  for (const file of syncTests()) {
    for (const header of headers(read(file))) {
      assert.notEqual(header.trim(), 'source-tree', `${file} declares source-tree`);
      if (header.startsWith('source-cell')) assert.match(header, /^source-cell packages\/[a-z]+(?: packages\/[a-z]+)*$/u, `${file} names cells by path`);
    }
  }
});
