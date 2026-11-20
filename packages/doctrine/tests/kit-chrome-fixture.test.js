/** @pullboard-world-pin: scans the tracked gate package test files for import lines naming the CLI app's chrome fixture and reads the app door, to prove the launcher's home is packages/gate tests [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** This file names the app path in its own source, so the scan skips it; stable.test.js is repointed by the view lane's own item. */
const SKIPPED = ['packages/doctrine/tests/kit-chrome-fixture.test.js', 'packages/gate/tests/stable.test.js'];

/** Tracked gate package files with an import or export line that names the CLI app's chrome fixture or its helpers. */
function gateImportersOfAppChrome() {
  try {
    return execFileSync('git', ['grep', '-lE', '^\\s*(import\\b|export\\b|\\} from).*apps/cli/tests/fixtures/chrome(/|\\.js)', '--', 'packages/gate'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && !SKIPPED.includes(file));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('doctrine.kit-chrome-fixture.clause-1-no-gate-test-imports-the-cli-chrome-fixture: clause 1: no gate test file imports the CLI chrome fixture, and the CLI chrome path is a door that re-exports the package home with export * from [C7]', () => {
  assert.deepEqual(gateImportersOfAppChrome(), []);
  const home = readFileSync(`${ROOT}packages/gate/tests/fixtures/chrome.js`, 'utf8');
  assert.match(home, /export async function startChrome\(/u);
  assert.doesNotMatch(home, /^\s*(import\b|export\b|\} from).*apps\//mu, 'the home imports no app file');
  const door = readFileSync(`${ROOT}apps/cli/tests/fixtures/chrome.js`, 'utf8');
  assert.match(door, /export \* from '[./]*packages\/gate\/tests\/fixtures\/chrome\.js'/u);
});
