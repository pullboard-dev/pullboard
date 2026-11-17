/** @pullboard-test-input source-cell packages/github */
/** The github cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9962]. */
/** @pullboard-world-pin: the clauses read the github cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/github/tests/inputs.test.js';
/** A file read by path: the same calls the gate's reader rule looks for, kept here so the cell imports no other cell. */
const READS = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
/** A path built from this file or the repo root, which is what makes a read an input of the checkout. */
const ANCHOR = /(?<![\w$])import\s*\.\s*meta\s*\.\s*(?:url|dirname|filename)\b|(?<![\w$.])ROOT\b/u;
/** A string or template literal naming the source tree, as its text before any \${ shows. */
const SOURCE_PATH = /['"`](?:[^'"`$]*\/)?src(?:\/|['"`])/u;
/** With the outside-src rule on, a literal naming tests/fixtures, data or docs counts too. */
const OUTSIDE_SRC_PATH = /['"`](?:[^'"`$]*\/)?(?:tests\/fixtures|data|docs)(?:\/|['"`])/u;
/** An innermost call whose arguments include both an anchor and a path literal, as join(ROOT, 'src/x.js') does. */
/** A module URL turned into .href names a module to import, not a file to read. */
const MODULE_URL = /new URL\([^()]*\)\.href/gu;
const CALL = /\(([^()]*)\)/gu;
const HEADER = /^\/\*\* @pullboard-test-input (.+) \*\/$/u;

/** Every test file under the github cell's tests folder, as repo-relative paths. */
function cellTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : cellTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');
/** The input header lines among a file's leading lines, as the text after the tag. */
const headers = source => source.split(/\r?\n/u).slice(0, 6).map(line => line.match(HEADER)?.[1]).filter(Boolean);
/** True when the file reads a path built from the checkout under the source tree (and, with `outside`, tests/fixtures, data or docs). */
function readsRepo(source, outside) {
  if (!READS.test(source)) return false;
  return [...source.replace(MODULE_URL, '').matchAll(CALL)].some(([, args]) => ANCHOR.test(args) && (SOURCE_PATH.test(args) || (outside && OUTSIDE_SRC_PATH.test(args))));
}

test('clause 1: every github test file that reads repo files carries an input header naming the cells it reads [C7,U149]', () => {
  const files = cellTests();
  assert.ok(files.includes(SELF) && files.length >= 2, 'the github cell has test files to check');
  const undeclared = files.filter(file => readsRepo(read(file), false) && headers(read(file)).length === 0);
  assert.deepEqual(undeclared, [], 'source readers without a header');
  assert.deepEqual(headers(read(SELF)), ['source-cell packages/github'], 'this file names only the github cell');
});

test('clause 2: with tests.requireDeclaredInputs on, no github test reads fixtures, data or docs without a header [C7,U149]', () => {
  const undeclared = cellTests().filter(file => readsRepo(read(file), true) && headers(read(file)).length === 0);
  assert.deepEqual(undeclared, [], 'readers without a header with the outside-src rule on');
  for (const file of cellTests()) {
    for (const header of headers(read(file))) assert.match(header, /^(?:source-tree|source-cell [\w/ -]+|test-tree|docs-tree|\S+(?: \S+)*)$/u, `${file} header is well formed`);
  }
});
