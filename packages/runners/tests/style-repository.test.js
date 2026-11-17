/** @pullboard-test-input apps/cli/src/io/static/checks.js */
/** The actual repository preflight keeps source oracles separate from browser behavior [C7]. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../gate/tests/fixtures/child.js';

test('runners.style.the-repository-static-style-command-enforces: the repository static style command enforces its source rules [C7]', () => {
  const before = performance.now();
  const child = runFixtureChild(process.execPath,
    ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', 'apps/cli/src/io/static/checks.js'],
    { cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8' });
  console.log(JSON.stringify({ staticProgramWallMs: performance.now() - before, status: child.status }));
  assert.equal(child.status, 0, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
});
