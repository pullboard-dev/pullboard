/** @pullboard-test-input source-cell packages/spec */
/** The spec cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9802]. */
/** @pullboard-world-pin: the clauses read the spec cell's own test files, which are the subject of the declared-inputs rule. */
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
const SELF = 'packages/spec/tests/inputs.test.js';

/** Every test file under the spec cell's tests folder, as repo-relative paths. */
function specTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return specTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');

test('clause 1: every spec test file that reads files carries an input header naming the cells it reads [C7,U149]', () => {
  const files = specTests();
  assert.ok(files.length >= 7, 'the spec cell has test files to check');
  const undeclared = files.filter(file => READ.test(read(file)) && !declaresSource(read(file)));
  assert.deepEqual(undeclared, [], 'file readers without a header');
  for (const file of ['packages/spec/tests/io/signature.test.js', 'packages/spec/tests/io/draft-writes.test.js']) {
    const [first] = read(file).split(/\r?\n/u);
    assert.equal(first, '/** @pullboard-test-input source-cell packages/spec */', `${file} names only the spec cell`);
  }
});

test('clause 2: with the outside-src rule on, the reader rule reports none in packages/spec/tests [C7,U149]', () => {
  const files = specTests();
  assert.ok(files.includes(SELF));
  assert.deepEqual(testInputProblems(ROOT, files, read, true), []);
});
