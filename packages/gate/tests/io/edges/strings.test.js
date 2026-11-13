/** The cells-edges ratchet counts a spawn, dynamic import or source read of another cell's file by path string as an edge [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  after,
  test,
} from 'node:test';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { cellsEdgeReport } from '../../../src/io/edges.js';

const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A scratch repo whose cell A holds `body` and whose cell B holds a source file. */
function repo(body) {
  const inputs = privateFixtureFiles('edges-strings-');
  made.push(inputs.root);
  inputs.write('packages/codemap/data/plan/cells.json', JSON.stringify({ cells: [] }));
  inputs.write('packages/b/src/tool.js', 'export const tool = 1;\n');
  inputs.write('packages/a/src/use.js', body);
  return inputs.root;
}

/** The distinct cells cell A's file reaches in the scratch repo. */
function reached(body) {
  const report = cellsEdgeReport(repo(body));
  return (report.files['packages/a/src/use.js']?.edges ?? []).map(edge => `${edge.from}->${edge.to}`);
}

test('clause 1: a spawn of a file in another cell by repo path counts as an edge [C7]', () => {
  assert.deepEqual(reached("import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, [join(root, 'packages/b/src/tool.js')]);\n"), ['a->b']);
});

test('clause 1: a spawn through a path variable counts as an edge [C7]', () => {
  assert.deepEqual(reached("const TOOL = join(root, 'packages/b/src/tool.js');\nexecFileSync(process.execPath, [TOOL]);\n"), ['a->b']);
});

test('clause 1: a dynamic import by repo path counts as an edge [C7]', () => {
  assert.deepEqual(reached("export const load = root => import(join(root, 'packages/b/src/tool.js'));\n"), ['a->b']);
});

test('clause 1: a source read by repo path counts as an edge [C7]', () => {
  assert.deepEqual(reached("export const text = root => readFileSync(join(root, 'packages/b/src/tool.js'), 'utf8');\n"), ['a->b']);
});

test('clause 1: a path named only as data is not an edge [C7]', () => {
  assert.deepEqual(reached("export const TABLE = { tool: 'packages/b/src/tool.js' };\nexport const say = () => new Error('packages/b/src/tool.js is gone');\n"), []);
});

test('clause 1: a path into the file own cell is not an edge [C7]', () => {
  assert.deepEqual(reached("spawnSync(process.execPath, [join(root, 'packages/a/src/use.js')]);\n"), []);
});
