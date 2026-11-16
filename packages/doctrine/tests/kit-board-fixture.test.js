/** @pullboard-world-pin: reads the app's board fixture doors and scans the tracked package test files for the CLI app's board fixture path, to prove the fixture's home is packages/board [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** This file names the app path in its own source, so the scan skips it. */
const SELF = 'packages/doctrine/tests/kit-board-fixture.test.js';

/** Tracked package test files that name the CLI app's board fixture (a package test importing the app kit). */
function importersOfAppBoardFixture() {
  try {
    return execFileSync('git', ['grep', '-lE', 'apps/cli/tests/fixtures/board\\.js', '--', 'packages/*/tests/*.js', 'packages/*/tests/**/*.js'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && file !== SELF);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('no package test file imports the CLI app board test fixture, and the app reaches the package one through the lib door [C7]', () => {
  assert.deepEqual(importersOfAppBoardFixture(), []);
  const door = readFileSync(`${ROOT}apps/lib/tests/fixtures/board.js`, 'utf8');
  assert.match(door, /import \{[^}]*fixtureBoard[^}]*\} from '[./]*packages\/board\/tests\/fixtures\/board\.js'/u);
  const appHome = readFileSync(`${ROOT}apps/cli/tests/fixtures/board.js`, 'utf8');
  assert.match(appHome, /export \{[^}]*fixtureBoard[^}]*\} from '[./]*lib\/tests\/fixtures\/board\.js'/u);
});
