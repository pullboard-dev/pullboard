/** @pullboard-world-pin: scans the tracked package test files for the CLI app's runner holders fixture path and reads the app door, to prove the helpers' home is packages/gate tests [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** This file names the app path in its own source, so the scan skips it. */
const SELF = 'packages/doctrine/tests/kit-runner-holders-fixture.test.js';

/** Tracked package test files that name the CLI app's runner holders fixture (a package test importing the app kit). */
function importersOfAppFixture() {
  try {
    return execFileSync('git', ['grep', '-lE', 'apps/cli/tests/fixtures/runner/holders\\.js', '--', 'packages/*.js'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && file !== SELF && /\/tests\//u.test(file));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('doctrine.kit-runner-holders-fixture.clause-1-no-package-test-file-imports: clause 1: no package test file imports the CLI app runner holders fixture, and the app path re-exports the package one [C7]', () => {
  assert.deepEqual(importersOfAppFixture(), []);
  const holders = readFileSync(`${ROOT}packages/gate/tests/fixtures/runner/holders.js`, 'utf8');
  assert.match(holders, /export function readRemoteGateHolders\(/u);
  assert.match(holders, /export async function waitForCondition\(/u);
  assert.doesNotMatch(holders, /apps\//u);
  const door = readFileSync(`${ROOT}apps/cli/tests/fixtures/runner/holders.js`, 'utf8');
  assert.match(door, /export \* from '[./]*packages\/gate\/tests\/fixtures\/runner\/holders\.js'/u);
});
