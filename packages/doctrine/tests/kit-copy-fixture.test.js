/** @pullboard-world-pin: scans every tracked file under packages/ for import lines naming the CLI app's copy fixture and reads the app door and the package home, to prove no package test imports it and the copy helpers' home is packages/gate tests [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** The doctrine scans name the app paths in their own source, so the scan skips them. */
const SKIPPED = ['packages/doctrine/tests/kit-chrome-fixture.test.js', 'packages/doctrine/tests/kit-copy-fixture.test.js', 'packages/doctrine/tests/kit-http-fixture.test.js'];
const HELPERS = ['fixtureCopierProblems', 'copyPackageFiles', 'copyPackageSubset', 'copyModuleClosure', 'copyCommittedPackageFiles', 'commitFixtureFiles'];

/** Tracked package files with an import or export line that names the CLI app's copy fixture. */
function packageImportersOfAppCopy() {
  try {
    return execFileSync('git', ['grep', '-lE', '^\\s*(import\\b|export\\b|\\} from).*apps/cli/tests/fixtures/copy(/|\\.js)', '--', 'packages'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && !SKIPPED.includes(file));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('doctrine.kit-copy-fixture.no-package-test-imports-the-cli-copy-fixture: #12459 clauses 1 and 2: no tracked file under packages/ imports the CLI copy fixture, the package home exports the copy helpers and imports no app file, and the CLI copy path is only an export * from door [C7]', () => {
  assert.deepEqual(packageImportersOfAppCopy(), []);
  const home = readFileSync(`${ROOT}packages/gate/tests/fixtures/package-copy.js`, 'utf8');
  for (const name of HELPERS) assert.match(home, new RegExp(`export (async )?(function ${name}\\(|\\{[^}]*\\b${name}\\b[^}]*\\})`, 'u'), `the home exports ${name}`);
  assert.doesNotMatch(home, /^\s*(import\b|export\b|\} from).*apps\//mu, 'the home imports no app file');
  const door = readFileSync(`${ROOT}apps/cli/tests/fixtures/copy.js`, 'utf8');
  assert.match(door, /^export \* from '[./]*packages\/gate\/tests\/fixtures\/package-copy\.js';$/mu);
  assert.doesNotMatch(door, /\bfunction\b/u, 'the door defines no helper of its own');
});
