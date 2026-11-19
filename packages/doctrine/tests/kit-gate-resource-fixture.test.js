/** @pullboard-world-pin: scans the tracked package test files for the CLI app's gate resource fixture path and reads the app door, to prove the fixture's home is packages/gate tests [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** This file names the app path in its own source, so the scan skips it. */
const SELF = 'packages/doctrine/tests/kit-gate-resource-fixture.test.js';

/** Tracked package files that name the CLI app's gate resource fixture path (a package test importing the app kit). */
function importersOfAppFixture() {
  try {
    return execFileSync('git', ['grep', '-lE', 'apps/cli/tests/fixtures/gate/resource\\.js', '--', 'packages/*.js'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && file !== SELF && /\/tests\//u.test(file));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('doctrine.kit-gate-resource-fixture.clause-1-no-package-test-file-imports: clause 1: no tracked package test file imports the CLI gate resource fixture [C7]', () => {
  assert.deepEqual(importersOfAppFixture(), []);
});

test('doctrine.kit-gate-resource-fixture.clause-2-package-home: clause 2: the package-side home exports the fixture names and the CLI path is only an export * door [C7]', () => {
  const home = readFileSync(`${ROOT}packages/gate/tests/fixtures/resource.js`, 'utf8');
  for (const name of ['waitFor', 'fixture', 'gateRepo', 'probeSuite', 'launchTestRunner', 'reapFixtures', 'trackChild']) {
    assert.match(home, new RegExp(`export (async )?function ${name}\\(`, 'u'), name);
  }
  assert.match(home, /export const RUNNER = /u);
  assert.doesNotMatch(home, /apps\/cli\/tests\//u);
  const door = readFileSync(`${ROOT}apps/cli/tests/fixtures/gate/resource.js`, 'utf8');
  assert.match(door, /^export \* from '[./]*packages\/gate\/tests\/fixtures\/resource\.js';$/mu);
  assert.doesNotMatch(door, /\b(function|class)\b/u);
});
