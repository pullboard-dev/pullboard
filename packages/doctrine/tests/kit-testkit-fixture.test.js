/** @pullboard-world-pin: scans the tracked package test files for the CLI app's testkit path and reads the app door, to prove the kit's home is packages/gate tests [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** This file names the app path in its own source, so the scan skips it. */
const SELF = 'packages/doctrine/tests/kit-testkit-fixture.test.js';

/** Tracked package test files that name the CLI app's testkit (a package test importing the app kit). */
function importersOfAppTestkit() {
  try {
    return execFileSync('git', ['grep', '-lE', 'apps/cli/tests/fixtures/testkit\\.js', '--', 'packages/*/tests/*.test.js', 'packages/*/tests/**/*.test.js'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && file !== SELF);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('doctrine.kit-testkit-fixture.no-package-test-file-imports-the-cli-app: no package test file imports the CLI app testkit, and the app reaches the package one through its door [C7]', () => {
  assert.deepEqual(importersOfAppTestkit(), []);
  const home = readFileSync(`${ROOT}packages/gate/tests/fixtures/testkit.js`, 'utf8');
  assert.match(home, /export function fileFixtureItem\(/u);
  assert.doesNotMatch(home, /apps\//u);
  const door = readFileSync(`${ROOT}apps/cli/tests/fixtures/testkit.js`, 'utf8');
  assert.match(door, /export \* from '[./]*packages\/gate\/tests\/fixtures\/testkit\.js'/u);
});
