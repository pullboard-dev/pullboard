/** @pullboard-test-input apps/lib/tests/** */
/** The lib app's tests name the exact files they read, so affected-test selection can see them [C7,#10239]. */
/** @pullboard-world-pin: the clauses read the lib app's own test files, which are the subject of the declared-inputs rule. */
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
const SELF = 'apps/lib/tests/inputs.test.js';
// The tests that read repo files by path, and the header each carries: exact files (or one folder glob), never a cell and never the whole tree.
const READERS = {
  'apps/lib/tests/env.test.js': ['packages/gate/src/io/run/tests.js'],
  'apps/lib/tests/cells/producer.test.js': ['apps/lib/src/io/main/audit.js'],
  'apps/lib/tests/no/cli.test.js': ['apps/cli/index.js', 'packages/codemap/src/io/cell/scripts/lints.js', 'packages/doctrine/src/io/fast.js', 'packages/gate/src/io/**'],
  'apps/lib/tests/durable/daemons.test.js': ['packages/gate/data/baselines/test-waits-baseline.json', 'packages/gate/src/io/changed/scripts/static.js', 'packages/gate/src/logic/load/bearing.js', 'packages/resources/src/io/handoff/worker/cap.js'],
  'apps/lib/tests/durable/land.test.js': ['apps/cli/src/io/commands/merged.js', 'apps/cli/src/io/commands/land.js'],
  'apps/lib/tests/durable/inventory.test.js': ['apps/cli/src/io/submit/remote.js', 'packages/gate/src/io/main/audit/nudge.js'],
};

/** Every test file under the lib app's tests folder, as repo-relative paths. */
function libTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return libTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');

test('lib.inputs.declared: clause 1: every lib test that reads repo files carries @pullboard-test-input lines naming the exact files it reads, never a whole cell [C7]', () => {
  const files = libTests();
  assert.ok(files.length > 50, 'the lib app has test files to check');
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

test('lib.inputs.rule-clean: clause 1: with the outside-src rule on, the reader rule reports none in apps/lib/tests, and no lib test carries a source-cell or source-tree header [C7]', () => {
  const files = libTests();
  assert.ok(files.includes(SELF));
  assert.deepEqual(testInputProblems(ROOT, files, read, true), []);
  const cells = files.filter(file => /@pullboard-test-input source-(?:cell|tree)\b/u.test(read(file)));
  assert.deepEqual(cells, []);
});
