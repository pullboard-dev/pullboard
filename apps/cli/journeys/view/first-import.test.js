/** Keep either front door importable first without a setupHelp ReferenceError [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runFixtureExecFile } from '../../../../packages/gate/tests/fixtures/child.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Import two front doors in order in a fresh process and return its stdout.
 *
 * Why: a fresh process has no module already loaded, so an import-order bug shows.
 */
function importInOrder(first, second) {
  const script = `await import('./${first}'); await import('./${second}'); console.log('loaded');`;
  return runFixtureExecFile(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('clause 1: importing the view front door, then the cli one, exits 0 with no ReferenceError [C7]', () => {
  assert.equal(importInOrder('apps/view/index.js', 'apps/cli/index.js').trim(), 'loaded');
});

test('clause 2: importing the cli front door, then the view one, exits 0 with no ReferenceError [C7]', () => {
  assert.equal(importInOrder('apps/cli/index.js', 'apps/view/index.js').trim(), 'loaded');
});
