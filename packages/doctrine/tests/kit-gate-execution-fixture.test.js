/** @pullboard-world-pin: scans the tracked package test files for the CLI app's gate execution fixture path and reads the package home and the app door, to prove the stand-in's home is packages/gate tests [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** This file names the app path in its own source, so the scan skips it. */
const SELF = 'packages/doctrine/tests/kit-gate-execution-fixture.test.js';

/** Tracked package test files that name the CLI app's gate execution fixture (a package test importing the app kit). */
function importersOfAppFixtures() {
  try {
    return execFileSync('git', ['grep', '-lE', 'apps/cli/tests/fixtures/gate/execution\\.js', '--', 'packages/*.js'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && file !== SELF && /\/tests\//u.test(file));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('doctrine.kit-gate-execution-fixture.clause-1-no-package-test-file-imports: clause 1: no package test file imports the CLI app gate execution fixture, its package home exports the three names, and the app path re-exports the package one [C7]', () => {
  assert.deepEqual(importersOfAppFixtures(), []);
  const home = readFileSync(`${ROOT}packages/gate/tests/fixtures/execution.js`, 'utf8');
  assert.match(home, /export const executionServices\b/u);
  assert.match(home, /export function executionServicesSource\(/u);
  assert.match(home, /export function redGateReleaseSource\(/u);
  assert.doesNotMatch(home, /apps\//u);
  const door = readFileSync(`${ROOT}apps/cli/tests/fixtures/gate/execution.js`, 'utf8');
  assert.match(door, /export \* from '[./]*packages\/gate\/tests\/fixtures\/execution\.js'/u);
});
