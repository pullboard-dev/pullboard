/** The cells edge ratchet refuses an undeclared new cross-cell import or deep import past a cell's index [C7]. */
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import {
  privateFixtureFiles,
  runFixtureChild,
  runFixtureGit,
} from '../../../../../apps/cli/tests/fixtures/child.js';
import {
  cellsEdgeProblems,
  cellsEdgeReport,
  ceilingsOf,
} from '../../../src/io/edges.js';

const REPO = join(import.meta.dirname, '../../../../..');
const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A fixture tree of cells a and b, with an optional plan declaring allowed edges. */
function fixture(files, allowedEdges) {
  const inputs = privateFixtureFiles('cells-edges-');
  const root = inputs.root;
  made.push(root);
  const all = { 'packages/codemap/data/plan/cells.json': JSON.stringify({ cells: [], ...(allowedEdges ? { allowedEdges } : {}) }), ...files };
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
  assert.ok(problems.some(row => row.text.includes('add "b->a/src" to allowedEdges in packages/codemap/data/plan/cells.json')), JSON.stringify(problems));
  const declared = fixture(files, ['b->a/src']);
  assert.deepEqual(cellsEdgeProblems(declared, { ceilings }), []);
});

test('clause 3: the check runs in the changed-file static list and in the full static preflight [C7]', () => {
  const root = fixture({ ...BASE, 'packages/b/deep.js': "import { inner } from '../a/src/inner.js';\nexport const deep = inner;\n" });
  mkdirSync(join(root, 'packages/gate/data/baselines'), { recursive: true });
  copyFileSync(join(REPO, 'packages/gate/data/baselines/test-waits-baseline.json'), join(root, 'packages/gate/data/baselines/test-waits-baseline.json'));
  copyFileSync(join(REPO, 'packages/gate/data/baselines/cli-launches.json'), join(root, 'packages/gate/data/baselines/cli-launches.json'));
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']]) {
    runFixtureGit(args, { cwd: root });
  }
  const run = runFixtureChild(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning',
    join(REPO, 'packages/gate/src/io/changed/scripts/static.js'), 'packages/b/deep.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /packages\/b\/deep\.js:1: deep import into a/u);
  assert.match(readFileSync(join(REPO, 'packages/gate/src/io/static/registry.js'), 'utf8'), /cellsEdgeProblems\(root,/u);
});

const CHECKS = join(REPO, 'packages/gate/src/io');

/** Every packages/gate/src/io check module whose main-module guard resolves process.argv[1] (#3666). */
function guardedChecks() {
  return readdirSync(CHECKS, { recursive: true }).filter(file => file.endsWith('.js'))
    .filter(file => readFileSync(join(CHECKS, file), 'utf8').includes('realpathSync(process.argv[1])'));
}

/** The source of an ES module that imports each named check, then prints how many it imported. */
function importSource(files) {
  return `${files.map(file => `await import(${JSON.stringify(pathToFileURL(join(CHECKS, file)).href)});`).join('\n')}\nconsole.log('imported', ${files.length});\n`;
}

test('clause 1: importing packages/gate/src/io/edges.js never throws when process.argv[1] names no file [C7]', () => {
  // The saved check-baseline worker retry runs `node -e <source> <id> <request>`, so argv[1] is an item id, not a file.
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', importSource(['edges.js']), '424242', 'request'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(child.status, 0, child.context);
  assert.doesNotMatch(child.stderr, /ENOENT/u);
  assert.match(child.stdout, /imported 1/u);
});

test('clause 2: every gate check main-module guard tolerates a deleted argv[1] script [C7]', () => {
  const files = guardedChecks();
  assert.ok(files.includes('edges.js') && files.includes('launches.js') && files.includes('sizes.js'), files.join(', '));
  const inputs = privateFixtureFiles('checks-main-guard-');
  made.push(inputs.root);
  inputs.write('gone.mjs', `import { unlinkSync } from 'node:fs';\nunlinkSync(process.argv[1]);\n${importSource(files)}`);
  const child = runFixtureChild(process.execPath, [join(inputs.root, 'gone.mjs')], { cwd: REPO, encoding: 'utf8' });
  assert.equal(child.status, 0, child.context);
  assert.doesNotMatch(child.stderr, /ENOENT/u);
  assert.match(child.stdout, new RegExp(`imported ${files.length}`, 'u'));
});
