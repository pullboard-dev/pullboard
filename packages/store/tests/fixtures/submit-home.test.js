/** @pullboard-test-input test-tree */
/** @pullboard-world-pin: reads apps/cli/tests/fixtures/board/submit.js and the tracked package test files, to prove the helper's home is the store package [C7,CD12]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** This file names the app path in its own source, so the scan skips it. */
const SELF = 'packages/store/tests/fixtures/submit-home.test.js';

/** Tracked package files that name the app's fixture path (a package test importing the app kit). */
function importersOfAppSubmit() {
  try {
    return execFileSync('git', ['grep', '-l', 'apps/cli/tests/fixtures/board/submit.js', '--', 'packages/*/tests/*.js', 'packages/*/tests/**/*.js'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && file !== SELF);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('store.fixtures-submit-home.store-fixtures-keep-the-board-submit: store fixtures keep the board-submit helpers in the package and the app re-exports them [CD12]', () => {
  assert.deepEqual(importersOfAppSubmit(), []);
  const appHome = readFileSync(`${ROOT}apps/cli/tests/fixtures/board/submit.js`, 'utf8');
  assert.match(appHome, /export (?:\*|\{[^}]*\}) from '[./]*packages\/store\/tests\/fixtures\/submit\.js'/u);
});
