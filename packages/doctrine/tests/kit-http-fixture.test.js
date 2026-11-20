/** @pullboard-world-pin: scans every tracked file under packages/ for import lines naming the CLI app's http fixture, to prove no package test imports it [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** The two doctrine scans name the app paths in their own source, so the scan skips them. */
const SKIPPED = ['packages/doctrine/tests/kit-http-fixture.test.js', 'packages/doctrine/tests/kit-chrome-fixture.test.js'];
/** An import or export line, or an import written inside a template string, naming the http fixture or its helpers. */
const IMPORT_LINE = '(import\\b|export\\b|\\} from).*apps/cli/tests/fixtures/http(/|\\.js)';

/** Tracked package files with an import line that names the CLI app's http fixture (a package test importing the app kit). */
function packageImportersOfAppHttpFixture() {
  try {
    return execFileSync('git', ['grep', '-lE', IMPORT_LINE, '--', 'packages/*.js'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && !SKIPPED.includes(file));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('doctrine.kit-http-fixture.no-package-test-imports-the-cli-http-fixture: #11414 clause 2: no tracked package file imports the CLI http fixture [C7]', () => {
  assert.deepEqual(packageImportersOfAppHttpFixture(), []);
});
