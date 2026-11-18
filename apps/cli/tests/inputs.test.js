/** @pullboard-test-input apps/cli/tests/** apps/cli/journeys/** */
/** The cli app's tests name the exact files they read, so affected-test selection can see them [C7,U149,#10477]. */
/** @pullboard-world-pin: the clauses read the cli app's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';
import { testInputProblems } from '../../../packages/gate/src/io/test/inputs.js';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const JOURNEYS = join(DIR, '..', 'journeys');

/** Every test file under the cli app's tests and journeys folders, as repo-relative paths. */
function cliTests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : cliTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');

test('declared inputs: clause 1: every cli test that reads repo files by path carries a @pullboard-test-input header at the top, with the outside-src rule on [C7,U149]', () => {
  const files = [...cliTests(DIR), ...cliTests(JOURNEYS)];
  assert.ok(files.length > 300, 'the cli app has test files to check');
  assert.deepEqual(testInputProblems(ROOT, files, read, true), []);
});

test('declared inputs: clause 2: the repaired readers name the exact files they read, never a cell or the whole tree [C7,U149]', () => {
  const named = {
    'apps/cli/tests/io/submit/cell-of-folder.test.js': 'packages/codemap/data/plan/**',
    'apps/cli/tests/io/submit/touched-cells-folder.test.js': 'packages/codemap/data/plan/**',
    'apps/cli/journeys/init/testkit.test.js': 'packages/gate/tests/fixtures/testkit.js',
    'apps/cli/journeys/settings/browser.test.js': 'apps/cli/tests/fixtures/person/trusted.js',
    'apps/cli/journeys/upgrade/previous-release.test.js': 'apps/cli/tests/fixtures/upgrade-093/**',
    'apps/cli/journeys/view/e2e.test.js': 'apps/cli/tests/fixtures/view/pty.py',
  };
  for (const [file, input] of Object.entries(named)) {
    const lines = read(file).split(/\r?\n/u).slice(0, 3);
    assert.ok(lines.includes(`/** @pullboard-test-input ${input} */`), `${file} names ${input} in its top lines`);
  }
});
