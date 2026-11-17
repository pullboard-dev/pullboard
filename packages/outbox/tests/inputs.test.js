/** @pullboard-test-input source-cell packages/outbox */
/** The outbox cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9973]. */
/** @pullboard-world-pin: the clause reads the outbox cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/outbox/tests/inputs.test.js';
/** A file read by path: the same calls the gate's reader rule looks for, kept here so the cell imports no other cell. */
const READS = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
/** An anchor the reader rule counts: the test's own location or a ROOT constant; a temporary fixture path has none. */
const ANCHOR = /(?<![\w$])import\s*\.\s*meta\s*\.\s*(?:url|dirname|filename)\b|(?<![\w$.])ROOT\b/u;
const HEADER = /^\/\*\* @pullboard-test-input (.+) \*\/$/u;

/** Every test file under the outbox cell's tests folder, as repo-relative paths. */
function cellTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cellTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = (path) => readFileSync(join(ROOT, path), 'utf8');
/** The input header lines among a file's leading lines, as the text after the tag. */
const headers = (source) => source.split(/\r?\n/u).slice(0, 5).map((line) => line.match(HEADER)?.[1]).filter(Boolean);

test('clause 1: every outbox test file that reads source files carries an input header naming the cells it reads, and none declares the whole tree [C7,U149]', () => {
  const files = cellTests();
  assert.ok(files.includes(SELF), 'the outbox cell has this test among its files');
  const undeclared = files.filter((file) => READS.test(read(file)) && ANCHOR.test(read(file)) && headers(read(file)).length === 0);
  assert.deepEqual(undeclared, [], 'file readers without a header');
  assert.deepEqual(headers(read(SELF)), ['source-cell packages/outbox'], 'this file names only the outbox cell');
  for (const file of files) {
    for (const header of headers(read(file))) {
      assert.notEqual(header.trim(), 'source-tree', `${file} declares source-tree`);
      assert.match(header, /^source-cell [a-z/]+(?: [a-z/]+)*$/u, `${file} names cells`);
    }
  }
});
