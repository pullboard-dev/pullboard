/** @pullboard-test-input source-tree */
/** The usage-checkpoint cut keeps the cells plan and edges check green [N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runFixtureChild } from './fixture-child.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** Run one repo script and demand a clean exit, showing its output when it is not. */
function exits(script, args) {
  const result = runFixtureChild(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 0, `${script}: ${result.stdout}${result.stderr}`);
}

test('clause 2: node bin/cells-plan.js --check and node bin/checks/cells-edges.js exit 0 [N2]', () => {
  exits('bin/cells-plan.js', ['--check']);
  exits('bin/checks/cells-edges.js', []);
});
