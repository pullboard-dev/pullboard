/** @pullboard-test-input packages/gate/src/io/run/tests.js packages/gate/data/ceilings/cells-edges.json */
/** @pullboard-world-pin: the clauses read the shim source and the committed ceiling, and run the shim on a tiny test file as a frozen item check would. */
/** The run-tests shim names no apps/ path, its ceiling row is gone, and a check frozen on its path still runs [C7]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from './fixtures/child.js';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { privateFixtureFiles } from './fixtures/child.js';

const FILE = 'packages/gate/src/io/run/tests.js';
const shim = fileURLToPath(new URL(`../../../${FILE}`, import.meta.url));

test('gate.app-edges-run.shim-names-apps-path: clause 1: the shim names no apps/ path [C7]', () => {
  assert.doesNotMatch(readFileSync(shim, 'utf8'), /apps\//u);
});

test('gate.app-edges-run.ceiling-holds-packageapps-row-shim: clause 1: the ceiling holds no packageApps row for the shim [C7]', () => {
  const ceilings = JSON.parse(readFileSync(new URL('../data/ceilings/cells-edges.json', import.meta.url), 'utf8'));
  assert.equal(ceilings.packageApps[FILE], undefined);
});

test('gate.app-edges-run.check-frozen-node-packages-gate: clause 1: a check frozen on node packages/gate/src/io/run/tests.js <file> still runs the file [C7]', t => {
  const tree = privateFixtureFiles('pb-run-shim-');
  const root = tree.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  tree.write('package.json', JSON.stringify({ type: 'module' }));
  tree.write('tiny.test.js', "import { test } from 'node:test';\ntest('tiny file ran through the shim [C7]', () => {});\n");
  const result = spawnSync(process.execPath, [shim, join(root, 'tiny.test.js')], {
    cwd: root,
    env: { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine') },
    encoding: 'utf8',
    detached: true,
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, out);
  assert.match(out, /tiny file ran through the shim/u);
});
