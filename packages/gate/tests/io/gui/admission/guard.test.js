/** @pullboard-test-input test-tree */
/** @pullboard-test-input source-tree */
/** @pullboard-test-input docs-tree */
/** Chrome-launching test files declare GUI requirements explicitly; the guard keeps the list complete [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { testsNeedGui } from '../../../../src/io/gui/admission.js';
import { runFixtureGit } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { chromeLaunchingTests } from '../../../fixtures/marker.js';

/** Read actual tracked paths through Git, preserving the source index as the completeness boundary. */
function trackedFiles(root) {
  return runFixtureGit(['ls-files', '-z'], { cwd: root, stdio: 'pipe' }).split('\0').filter(Boolean);
}

test('the GUI marker guard follows literal launcher imports without evaluating fixture source [C7,V4]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-gui-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  const sources = {
    'apps/cli/tests/fixtures/chrome.js': "throw new Error('the guard must never evaluate a launcher');",
    'test/bridge.js': "export { startChrome } from '../apps/cli/tests/fixtures/chrome.js';",
    'test/direct.test.js': "import { startChrome } from '../apps/cli/tests/fixtures/chrome.js';",
    'test/wrapped.test.mjs': "await import('./bridge.js');",
    'test/ordinary.test.js': "const example = \"import { startChrome } from '../apps/cli/tests/fixtures/chrome.js';\";",
  };
  for (const [file, source] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  runFixtureGit(['add', '.'], { cwd: root, stdio: 'pipe' });
  const launchers = chromeLaunchingTests(root, trackedFiles(root));
  assert.deepEqual(launchers, ['test/direct.test.js', 'test/wrapped.test.mjs']);
  assert.deepEqual(launchers.filter(file => !testsNeedGui(root, [file])), launchers, 'the refusal names each missing file');
  for (const file of launchers) writeFileSync(join(root, file), '/** @pullboard-test-gui */\n' + sources[file]);
  assert.deepEqual(launchers.filter(file => !testsNeedGui(root, [file])), [], 'explicit headers satisfy the same guard');
});

test('every test importing a Chrome launcher explicitly declares its GUI requirement [C7,V4]', () => {
  const root = resolve(import.meta.dirname, '../../../../../..');
  const launchers = chromeLaunchingTests(root, trackedFiles(root));
  const missing = launchers.filter(file => !testsNeedGui(root, [file]));
  assert.deepEqual(missing, [], 'missing @pullboard-test-gui header in Chrome-launching test files: ' + missing.join(', '));
});
