/** @pullboard-test-input packages/receipt/tests/** */
/** The receipt cell's tests name the exact files they read, so affected-test selection can see them [C7]. */
/** @pullboard-world-pin: the clauses read the receipt cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';
import { declaresSource } from '../../gate/src/io/test/inputs.js';
import { testInputProblems } from '../../gate/src/io/test/inputs.js';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/receipt/tests/inputs.test.js';
// The tests that read repo files by path, and the header each carries: exact files (or one folder glob), never a cell and never the whole tree.
const READERS = {
  'packages/receipt/tests/registry.test.js': ['packages/receipt/tests/**'],
};

/** Every test file under the receipt cell's tests folder, as repo-relative paths. */
function receiptTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return receiptTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('receipt.inputs.declared: clause 1: every receipt test that reads repo files carries @pullboard-test-input lines naming the exact files it reads, never a whole cell [C7]', () => {
  const files = receiptTests();
  assert.ok(files.length >= 6, 'the receipt cell has test files to check');
  for (const [file, tokens] of Object.entries(READERS)) {
    const [first] = read(file).split(/\r?\n/u);
    assert.equal(first, `/** @pullboard-test-input ${tokens.join(' ')} */`, `${file} names exactly the files it reads`);
    assert.ok(declaresSource(read(file)), `${file} declares its inputs`);
    for (const token of tokens) {
      assert.ok(!/^source-(?:cell|tree)$/u.test(token) && !token.startsWith('/') && !token.includes('..'), `${file}: ${token} is a repo path`);
      assert.ok(existsSync(join(ROOT, token.replace(/\/\*\*$/u, ''))), `${file}: ${token} exists`);
    }
  }
});

test('receipt.inputs.rule-clean: clause 1: with the outside-src rule on, the reader rule reports none in packages/receipt/tests, and none of the named readers carries a source-cell header [C7]', () => {
  const files = receiptTests();
  assert.ok(files.includes(SELF));
  assert.deepEqual(testInputProblems(ROOT, files, read, true), []);
  const cells = Object.keys(READERS).filter((file) => /@pullboard-test-input source-cell/u.test(read(file)));
  assert.deepEqual(cells, []);
});
