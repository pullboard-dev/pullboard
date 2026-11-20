/** @pullboard-world-pin: scans the tracked sync package test files for the CLI app's http fixture path, to prove the fixture's home is packages/sync [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** This file names the app path in its own source, so the scan skips it. */
const SELF = 'packages/doctrine/tests/kit-http-fixture.test.js';

/** Tracked sync test files that name the CLI app's http fixture (a package test importing the app kit). */
function syncImportersOfAppHttpFixture() {
  try {
    return execFileSync('git', ['grep', '-lE', 'apps/cli/tests/fixtures/http\\.js', '--', 'packages/sync/tests'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && file !== SELF);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('doctrine.kit-http-fixture.clause-1-sync-tests-use-their-own-http-fixture: #11116 clause 1: no tracked test file of the sync package names the CLI http fixture path [C7]', () => {
  assert.deepEqual(syncImportersOfAppHttpFixture(), []);
});
