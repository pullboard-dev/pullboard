/** The cells edge ratchet refuses an undeclared new cross-cell import or deep import past a cell's index [C7]. */
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { privateFixtureFiles, runFixtureChild, runFixtureGit } from './fixture-child.js';
import {
  cellsEdgeProblems,
  cellsEdgeReport,
  ceilingsOf,
} from '../bin/checks/cells-edges.js';

const REPO = join(import.meta.dirname, '..');
const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A fixture tree of cells a and b, with an optional plan declaring allowed edges. */
function fixture(files, allowedEdges) {
  const inputs = privateFixtureFiles('cells-edges-');
  const root = inputs.root;
  made.push(root);
  const all = { 'bin/cells-plan.json': JSON.stringify({ cells: [], ...(allowedEdges ? { allowedEdges } : {}) }), ...files };
  for (const [file, text] of Object.entries(all)) {
    inputs.write(file, text);
  }
  return root;
}

const BASE = {
  'packages/a/index.js': 'export const a = 1;\n',
  'packages/a/src/inner.js': 'export const inner = 1;\n',
  'packages/b/index.js': "import { a } from '../a/index.js';\nexport const b = a;\n",
};

test('clause 1: a new cross-cell import and a deep import beyond the ceiling are flagged and a clean file passes [C7]', () => {
  const root = fixture(BASE);
  const ceilings = ceilingsOf(cellsEdgeReport(root));
  assert.deepEqual(cellsEdgeProblems(root, { ceilings }), [], 'today passes');
  writeFileSync(join(root, 'packages/a/more.js'), "import { b } from '../b/index.js';\nexport const more = b;\n");
  writeFileSync(join(root, 'packages/b/deep.js'), "import { inner } from '../a/src/inner.js';\nexport const deep = inner;\n");
  writeFileSync(join(root, 'packages/b/clean.js'), 'export const clean = 1;\n');
  writeFileSync(join(root, 'packages/b/other.js'), "import { a } from '../a/index.js';\nexport const other = a;\n");
  const text = cellsEdgeProblems(root, { ceilings }).map(row => `${row.path}:${row.line}: ${row.text}`).join('\n');
  assert.match(text, /packages\/a\/more\.js:1: new cross-cell import of b/u);
  assert.match(text, /packages\/b\/deep\.js:1: deep import into a's src/u);
  assert.match(text, /packages\/b\/other\.js:1: new cross-cell import of a/u, 'a new file importing a cell the cell already imports elsewhere still exceeds its own 0 ceiling');
  assert.doesNotMatch(text, /clean\.js/u);
});

test('clause 2: the same new edge passes once the plan declares it and the refusal names the declaration [C7]', () => {
  const files = { ...BASE, 'packages/b/deep.js': "import { inner } from '../a/src/inner.js';\nexport const deep = inner;\n" };
  const before = fixture({ ...BASE });
  const ceilings = ceilingsOf(cellsEdgeReport(before));
  const refused = fixture(files);
  const problems = cellsEdgeProblems(refused, { ceilings });
  assert.ok(problems.some(row => row.text.includes('add "b->a/src" to allowedEdges in bin/cells-plan.json')), JSON.stringify(problems));
  const declared = fixture(files, ['b->a/src']);
  assert.deepEqual(cellsEdgeProblems(declared, { ceilings }), []);
});

test('clause 3: the check runs in the changed-file static list and in the full static preflight [C7]', () => {
  const root = fixture({ ...BASE, 'packages/b/deep.js': "import { inner } from '../a/src/inner.js';\nexport const deep = inner;\n" });
  mkdirSync(join(root, 'bin/checks'), { recursive: true });
  copyFileSync(join(REPO, 'bin/checks/test-waits-baseline.json'), join(root, 'bin/checks/test-waits-baseline.json'));
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']]) {
    runFixtureGit(args, { cwd: root });
  }
  const run = runFixtureChild(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning',
    join(REPO, 'bin/checks/changed-static.js'), 'packages/b/deep.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /packages\/b\/deep\.js:1: deep import into a/u);
  assert.match(readFileSync(join(REPO, 'bin/checks/static-tree-registry.js'), 'utf8'), /cellsEdgeProblems\(root\)/u);
});
