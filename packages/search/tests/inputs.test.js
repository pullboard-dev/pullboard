/** @pullboard-test-input source-cell packages/search */
/** The search cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9983]. */
/** @pullboard-world-pin: the clauses read the search cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/search/tests/inputs.test.js';
/** A file read by path: the same calls the gate's reader rule looks for, kept here so this cell imports no other cell. */
const READS = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
/** A read anchored to the repo: the file's own location or a repo root, so reads of a temp folder are not counted. */
const ANCHOR = /(?<![\w$])import\s*\.\s*meta\s*\.\s*(?:url|dirname|filename)\b|(?<![\w$.])(?:ROOT|REPO)\b/u;
const HEADER = /^\/\*\* @pullboard-test-input (.+) \*\/$/u;

/** Every test file under the search cell's tests folder, as repo-relative paths. */
function searchTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return searchTests(path);
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

test('search.inputs.every-reader-declares-its-inputs: clause 1: every search test file that reads files carries an input header naming what it reads [C7,U149]', () => {
  const files = searchTests();
  assert.ok(files.includes(SELF) && files.length >= 2, 'the search cell has test files to check');
  const undeclared = files.filter(file => READS.test(read(file)) && ANCHOR.test(read(file)) && headers(read(file)).length === 0);
  assert.deepEqual(undeclared, [], 'file readers without a header');
  assert.deepEqual(headers(read(SELF)), ['source-cell packages/search'], 'this file names only the search cell');
});

test('search.inputs.a-header-names-a-cell-never-the-tree: clause 1: every search input header is a cell, the test tree, the source tree or named files [C7,U149]', () => {
  for (const file of searchTests()) {
    for (const header of headers(read(file))) {
      assert.match(header, /^(?:source-tree|source-cell [a-z/ ]+|test-tree|\S+\.(?:js|json))(?: \S+\.(?:js|json))*$/u, `${file} declares a well-formed input`);
    }
  }
});

/** The only search test that reads a whole tree, and the tree headers it must declare; no other file may use a tree header. */
const WHOLE_TREE = new Map([['packages/search/tests/io/index.test.js', ['source-tree']]]);
const TREE = /^(?:source-tree|test-tree|docs-tree)$/u;

test('search.inputs.only-the-listed-reader-uses-a-tree: clause 2: only the listed whole-tree reader uses a tree header, and it still declares it [C7,U149]', () => {
  for (const file of searchTests()) {
    const trees = headers(read(file)).filter(header => TREE.test(header));
    assert.deepEqual(trees, WHOLE_TREE.get(file) ?? [], `${file} tree headers`);
  }
  for (const file of WHOLE_TREE.keys()) assert.ok(searchTests().includes(file), `${file} is still a search test`);
});
