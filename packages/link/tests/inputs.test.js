/** @pullboard-test-input source-cell packages/link */
/** The link cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9971]. */
/** @pullboard-world-pin: the clauses read the link cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/link/tests/inputs.test.js';
/** Test files that read committed repo files, not temporary ones, so they must declare what they read. */
const REPO_READERS = [
  "packages/link/tests/io/relay.test.js",
  "packages/link/tests/io/behind-device-pass.test.js",
  "packages/link/tests/logic/relay/order.test.js"
];
/** Existing whole-tree declarations that stay as they are; no other link test declares the whole tree. */
const TREE_OK = [];
/** A file read by path: the same calls the gate's reader rule looks for, kept here so the cell imports no other cell. */
const READS = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
/** A read whose own line names the repo root or this file's location, so it opens a repo file. */
const REPO_READ_LINE = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\([^\n]*(?:import\.meta\.(?:url|dirname|filename)|(?<![\w$.])(?:ROOT|REPO)\b)/u;
const HEADER = /^\/\*\* @pullboard-test-input (.+) \*\/$/u;

/** Every test file under the link cell's tests folder, as repo-relative paths. */
function cellTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cellTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');
/** The input header lines among a file's leading comment lines, as the text after the tag. */
const headers = source => source.split(/\r?\n/u).slice(0, 5).map(line => line.match(HEADER)?.[1]).filter(Boolean);

test('clause 1: every link test file that reads repo files carries an input header naming the cells it reads [C7,U149]', () => {
  const files = cellTests();
  assert.ok(files.includes(SELF) && files.length >= 2, 'the link cell has test files to check');
  for (const reader of REPO_READERS) assert.ok(files.includes(reader), `${reader} is a link test`);
  const bare = files.filter(file => (REPO_READERS.includes(file) || REPO_READ_LINE.test(read(file))) && headers(read(file)).length === 0);
  assert.deepEqual(bare, [], 'repo readers without a header');
  assert.deepEqual(headers(read(SELF)), ['source-cell packages/link'], 'this file names only the link cell');
  assert.ok(files.some(file => READS.test(read(file))), 'the scan sees file reads');
});

test('clause 2: no link test declares the whole source tree except the existing ones, and every header names cells or files [C7,U149]', () => {
  for (const file of cellTests()) {
    for (const header of headers(read(file))) {
      if (header.trim() === 'source-tree') assert.ok(TREE_OK.includes(file), `${file} declares source-tree`);
      else assert.match(header, /^(?:source-cell (?:packages|apps)\/[a-z]+(?: (?:packages|apps)\/[a-z]+)*|(?:packages|apps)\/\S+(?: (?:packages|apps)\/\S+)*)$/u, `${file} names cells or files by path`);
    }
  }
});
