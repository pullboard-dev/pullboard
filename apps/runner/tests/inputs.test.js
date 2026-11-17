/** @pullboard-test-input apps/runner/tests/** */
/** The runner app's tests name the exact files they read, so affected-test selection can see them [C7,#10238]. */
/** @pullboard-world-pin: the clauses read the runner app's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';
import { declaresSource } from '../../../packages/gate/src/io/test/inputs.js';
import { testInputProblems } from '../../../packages/gate/src/io/test/inputs.js';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'apps/runner/tests/inputs.test.js';
// The tests that read repo files by path, and the header each carries: exact files (or one folder glob), never a cell and never the whole tree.
const READERS = {
  'apps/runner/tests/closure.test.js': ['package.json', 'apps/runner/src/io/scripts/worker.js', 'apps/runner/src/io/worker.js', 'packages/resources/src/io/artifact.js', 'packages/runners/src/io/main.js'],
  'apps/runner/tests/recovery/idle.test.js': ['apps/runner/index.js', 'packages/resources/index.js', 'packages/runners/index.js'],
  'apps/runner/tests/io/controller-pull-only.test.js': ['apps/runner/src/io/controller.js', 'apps/runner/tests/io/orphans.test.js'],
  'apps/runner/tests/io/custody-waits.test.js': ['apps/runner/src/io/custody.js', 'apps/runner/src/io/worker/process.js'],
  'apps/runner/tests/io/orphans.test.js': ['apps/runner/src/io/scripts/worker.js'],
  'apps/runner/tests/io/private/pull-only.test.js': ['apps/runner/src/io/private/privacy.js'],
  'apps/runner/tests/io/private/renames.test.js': ['apps/runner/src/io/private/privacy.js', 'packages/gate/src/io/check/rename.js'],
  'apps/runner/tests/io/checkout-cli-path.test.js': ['apps/runner/src/io/worker/environment.js'],
  'apps/runner/tests/io/chrome/process.test.js': ['packages/runners/index.js'],
};

/** Every test file under the runner app's tests folder, as repo-relative paths. */
function runnerTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return runnerTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');

test('runner.inputs.declared: clause 1: every runner test that reads repo files carries @pullboard-test-input lines naming the exact files it reads, never a whole cell [C7]', () => {
  const files = runnerTests();
  assert.ok(files.length > 20, 'the runner app has test files to check');
  for (const [file, tokens] of Object.entries(READERS)) {
    const [first] = read(file).split(/\r?\n/u);
    const header = read(file).split(/\r?\n/u).find(line => line.startsWith('/** @pullboard-test-input '));
    assert.ok(header, `${file} carries a header (first line: ${first})`);
    assert.equal(header, `/** @pullboard-test-input ${tokens.join(' ')} */`, `${file} names exactly the files it reads`);
    assert.ok(declaresSource(read(file)), `${file} declares its inputs`);
    for (const token of tokens) {
      assert.ok(!/^source-(?:cell|tree)$/u.test(token) && !token.startsWith('/') && !token.includes('..'), `${file}: ${token} is a repo path`);
      assert.ok(existsSync(join(ROOT, token.replace(/\/\*\*$/u, ''))), `${file}: ${token} exists`);
    }
  }
});

test('runner.inputs.rule-clean: clause 1: with the outside-src rule on, the reader rule reports none in apps/runner/tests, and no runner test carries a source-cell or source-tree header [C7]', () => {
  const files = runnerTests();
  assert.ok(files.includes(SELF));
  assert.deepEqual(testInputProblems(ROOT, files, read, true), []);
  const cells = files.filter(file => /@pullboard-test-input source-(?:cell|tree)\b/u.test(read(file)));
  assert.deepEqual(cells, []);
});
