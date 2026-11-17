/** @pullboard-test-input packages/runners/tests/** */
/** The runners cell's tests name the exact files they read, so affected-test selection can see them [C7,U149,#9981]. */
/** @pullboard-world-pin: the clauses read the runners cell's own test files, which are the subject of the declared-inputs rule. */
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
const SELF = 'packages/runners/tests/inputs.test.js';
// The tests that read repo files by path, and the header each carries: exact files (or one folder glob), never a cell and never the whole tree.
const READERS = {
  'packages/runners/tests/fixture-copiers.test.js': ['packages/runners/tests/**'],
  'packages/runners/tests/io/main.test.js': ['package.json', 'apps/runner/src/io/scripts/worker.js', 'packages/runners/src/io/policy.js', 'packages/sandbox/src/io/trusted/policy/committed.js'],
  'packages/runners/tests/io/package/closure.test.js': ['packages/resources/src/io/handoff/prune.js'],
  'packages/runners/tests/io/service/bundle.test.js': ['packages/state/src/logic/engines/**'],
  'packages/runners/tests/io/tooling/bundle.test.js': ['package.json', 'apps/runner/src/io/scripts/worker.js', 'packages/runners/src/io/tooling/remote.js'],
  'packages/runners/tests/io/tooling/trusted-cache-export.test.js': ['package.json', 'apps/runner/src/io/scripts/worker.js', 'packages/runners/src/io/tooling/remote.js'],
  'packages/runners/tests/lookups.test.js': ['packages/resources/src/io/admission/memory.js', 'packages/gate/tests/fixtures/diagnostics.js', 'packages/sentinels/src/io/cpu.js'],
  'packages/runners/tests/neutral-host.test.js': ['packages/runners/**'],
  'packages/runners/tests/refresh.test.js': ['package.json', 'apps/runner/src/io/scripts/worker.js'],
  'packages/runners/tests/version.test.js': ['package.json', 'apps/cli/pullboard.js', 'packages/store/src/io/board/schema/source.js', 'packages/pages/src/io/relay/presentation.js'],
  'packages/runners/tests/io/dispatch/bridge-module.test.js': ['packages/runners/src/io/bridge.js', 'packages/runners/src/io/dispatch.js'],
  'packages/runners/tests/io/dispatch/pull-front.test.js': ['packages/runners/src/io/pull/delegate.js', 'packages/runners/src/io/health.js'],
};

/** Every test file under the runners cell's tests folder, as repo-relative paths. */
function runnersTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return runnersTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');

test('runners.inputs.declared: clause 1: every runners test that reads repo files carries @pullboard-test-input lines naming the exact files it reads, never a whole cell [C7,U149]', () => {
  const files = runnersTests();
  assert.ok(files.length > 50, 'the runners cell has test files to check');
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

test('runners.inputs.rule-clean: clause 1: with the outside-src rule on, the reader rule reports none in packages/runners/tests, and none of the named readers carries a source-cell header [C7,U149]', () => {
  const files = runnersTests();
  assert.ok(files.includes(SELF));
  assert.deepEqual(testInputProblems(ROOT, files, read, true), []);
  const cells = Object.keys(READERS).filter(file => /@pullboard-test-input source-cell/u.test(read(file)));
  assert.deepEqual(cells, []);
});
