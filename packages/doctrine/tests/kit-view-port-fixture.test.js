/** @pullboard-world-pin: scans every tracked file under packages/ for import lines naming the CLI app's view port fixture and reads the app door, to prove no package test imports it and chooseViewPort's home is packages/gate tests [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** The doctrine scans name the app paths in their own source, so the scan skips them. */
const SKIPPED = ['packages/doctrine/tests/kit-view-port-fixture.test.js'];
/** An import or export line, or an import written inside a template string, naming the view port fixture. */
const IMPORT_LINE = '(import\\b|export\\b|\\} from).*apps/cli/tests/fixtures/view/port(/|\\.js)';

/** Tracked package files with an import line that names the CLI app's view port fixture (a package test importing the app kit). */
function packageImportersOfAppViewPort() {
  try {
    return execFileSync('git', ['grep', '-lE', IMPORT_LINE, '--', 'packages'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && !SKIPPED.includes(file));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('doctrine.kit-view-port-fixture.no-package-test-imports-the-cli-view-port-fixture: #12460 clauses 1 and 2: no tracked package file imports the CLI view port fixture, and the app path is a testkit-shaped door onto the gate home [C7]', () => {
  assert.deepEqual(packageImportersOfAppViewPort(), []);
  const home = readFileSync(`${ROOT}packages/gate/tests/fixtures/view-port.js`, 'utf8');
  assert.match(home, /export async function chooseViewPort\(/u);
  assert.doesNotMatch(home, /^\s*(import\b|export\b|\} from).*apps\//mu, 'the home imports no app file');
  const door = readFileSync(`${ROOT}apps/cli/tests/fixtures/view/port.js`, 'utf8');
  const lines = door.split('\n').filter(line => line.trim() && !/^\s*(\/\*\*|\*|\/\/)/u.test(line));
  assert.deepEqual(lines, [
    "import { chooseViewPort } from '../../../../../packages/gate/tests/fixtures/view-port.js';",
    "export * from '../../../../../packages/gate/tests/fixtures/view-port.js';",
    'export const VIEW_PORT_CHOOSER = chooseViewPort;'], 'the app door has the testkit shape: one import, an export * from the home, one const export');
});
