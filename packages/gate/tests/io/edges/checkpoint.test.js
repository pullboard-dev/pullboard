/** @pullboard-test-input packages/codemap/src/io/cells/scripts/plan.js packages/gate/src/io/edges.js */
/** The usage-checkpoint cut keeps the cells plan and edges check green [N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runFixtureChild } from '../../fixtures/child.js';

const REPO = fileURLToPath(new URL('../../../../..', import.meta.url));

/** Run one repo script and demand a clean exit, showing its output when it is not. */
function exits(script, args) {
  const result = runFixtureChild(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 0, `${script}: ${result.stdout}${result.stderr}`);
}

test('gate.io-edges-checkpoint.node-packages-codemap-src-io-cells: clause 2: node packages/codemap/src/io/cells/scripts/plan.js --check and node packages/gate/src/io/edges.js exit 0 [N2]', () => {
  exits('packages/codemap/src/io/cells/scripts/plan.js', ['--check']);
  exits('packages/gate/src/io/edges.js', []);
});
