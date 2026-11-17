/** @pullboard-test-input source-cell packages/state */
/** The state cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9989]. */
/** @pullboard-world-pin: the clauses read the state cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';
import { declaresSource } from '../../gate/src/io/test/inputs.js';
import { READ } from '../../gate/src/io/test/inputs.js';
import { testInputProblems } from '../../gate/src/io/test/inputs.js';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/state/tests/inputs.test.js';

/** Every test file under the state cell's tests folder, as repo-relative paths. */
function cellTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cellTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');

test('clause 1: every state test file that reads files carries an input header naming the cells it reads [C7,U149]', () => {
  const files = cellTests();
  assert.ok(files.includes(SELF) && files.length >= 2, 'the state cell has test files to check');
  const undeclared = files.filter(file => READ.test(read(file)) && !declaresSource(read(file)));
  assert.deepEqual(undeclared, [], 'file readers without a header');
  const [first] = read(SELF).split(/\r?\n/u);
  assert.equal(first, '/** @pullboard-test-input source-cell packages/state */', 'this file names only the state cell');
});

test('clause 2: with the outside-src rule on, the reader rule reports none in packages/state/tests [C7,U149]', () => {
  const files = cellTests();
  assert.deepEqual(testInputProblems(ROOT, files, read, true), []);
});
