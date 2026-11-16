/** @pullboard-test-input apps/cli/src/io/static/checks.js packages/runners/tests/fixtures/static-checks.js */
/** The actual repository preflight keeps source oracles separate from browser behavior [C7]. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runStaticChecks } from './fixtures/static-checks.js';

test('the repository static style command enforces its source rules [C7]', async () => {
  const before = performance.now();
  const child = await runStaticChecks(resolve(import.meta.dirname, '../../..'));
  console.log(JSON.stringify({ staticProgramWallMs: performance.now() - before, status: child.status }));
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
