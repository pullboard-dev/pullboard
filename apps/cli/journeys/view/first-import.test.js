/** Keep importing the view front door first from raising a setupHelp ReferenceError [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Import the view front door and then the cli one in a fresh process.
 *
 * Why: a fresh process has no module already loaded, so an import-order bug shows.
 */
function importViewThenCli() {
  const script = "await import('./apps/view/index.js'); await import('./apps/cli/index.js'); console.log('loaded');";
  return execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('a fresh process importing the view front door first, then the cli one, raises no ReferenceError [C7]', () => {
  assert.equal(importViewThenCli().trim(), 'loaded');
});
