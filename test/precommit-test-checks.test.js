/** The repository pre-commit hook refuses the gate's test fixture and test-name reds on staged files, with the gate's messages [C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { fixtureProblems } from '../bin/checks/test-fixtures.js';
import { testNameProblems } from '../bin/checks/test-names.js';
import { STAGED_TEST_CHECKS } from '../bin/checks/changed-static.js';

const helpers = createE2eHelpers();
after(() => helpers.cleanup());

const REPO = join(import.meta.dirname, '..');
const CHECKS = join(REPO, 'bin', 'checks');
const NODE_FLAGS = ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'];

/** The four static reds that cost the most gates on 7 Nov, each alone in its own test file. */
const CASES = [
  ['test/tempdir.test.js', "import { mkdtempSync } from 'node:fs';\nexport const dir = mkdtempSync('fixture-');\n", /tempdir: creates a temporary directory/u],
  ['test/model.test.js', "process.env.PULLBOARD_MODEL = 'sonnet';\n", /model: passes a literal model string/u],
  ['test/board.test.js', "export const board = openBoard('board.db');\n", /raw-board: opens a board or adds an item in process/u],
  ['test/name.test.js', "import { test } from 'node:test';\ntest('adds two numbers', () => {});\n", /test name has no spec row id: adds two numbers/u],
];

/**
 * A project that commits through the repository's own pre-commit hook. Its staged checker delegates to this checkout's
 * bin/checks/changed-static.js, and its ceilings files are committed, as in the real repository.
 */
function hookedProject() {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  mkdirSync(join(box.repo, 'bin', 'checks'), { recursive: true });
  mkdirSync(join(box.repo, '.githooks'), { recursive: true });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  copyFileSync(join(CHECKS, 'test-waits-baseline.json'), join(box.repo, 'bin', 'checks', 'test-waits-baseline.json'));
  writeFileSync(join(box.repo, 'bin', 'checks', 'test-fixtures.json'), '{}\n');
  writeFileSync(join(box.repo, 'bin', 'checks', 'changed-static.js'), [
    `import { stagedHookFailures } from ${JSON.stringify(pathToFileURL(join(CHECKS, 'changed-static.js')).href)};`,
    'const failures = stagedHookFailures(process.cwd());',
    "if (failures.length) { process.stderr.write(failures.join('\\n') + '\\n'); process.exitCode = 1; }", ''].join('\n'));
  copyFileSync(join(REPO, '.githooks', 'pre-commit'), join(box.repo, '.githooks', 'pre-commit'));
  chmodSync(join(box.repo, '.githooks', 'pre-commit'), 0o755);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '--no-verify', '-m', 'chore: record the static ceilings and the repository hook');
  box.git(box.repo, 'config', 'core.hooksPath', '.githooks');
  return box;
}

/** Run the staged checker the hook runs, without committing. */
function stagedCheck(box) {
  return spawnSync(process.execPath, [...NODE_FLAGS, join(box.repo, 'bin', 'checks', 'changed-static.js')], { cwd: box.repo, env: box.env, encoding: 'utf8' });
}

test('the real pre-commit hook refuses a temp dir, a model literal, a raw board and an unnamed test with the gate static stage messages, clause 1 [C7]', () => {
  const box = hookedProject();
  for (const [file, source] of CASES) writeFileSync(join(box.repo, file), source);
  const gate = [
    ...fixtureProblems(box.repo, join(box.repo, 'bin', 'checks', 'test-fixtures.json'), { base: null }),
    ...testNameProblems(box.repo),
  ].map(row => `${row.path}:${row.line}: ${row.text}`);
  for (const [file, , message] of CASES) {
    const printed = gate.filter(line => line.startsWith(`${file}:`));
    assert.equal(printed.length, 1, `the gate prints one red for ${file}: ${gate.join('\n')}`);
    assert.match(printed[0], message);
    box.git(box.repo, 'add', file);
    const commit = box.tryGit(box.repo, 'commit', '-q', '-m', 'test: add a fixture case [C7]');
    const output = `${commit.stderr ?? commit.err ?? ''}${commit.stdout ?? commit.out ?? ''}`;
    assert.notEqual(commit.status ?? commit.code, 0, `the hook refuses ${file}`);
    assert.ok(output.includes(printed[0]), `the hook prints the gate line ${printed[0]}, got:\n${output}`);
    box.git(box.repo, 'reset', '-q');
  }
  assert.match(box.git(box.repo, 'log', '-1', '--format=%s'), /record the static ceilings/u, 'no refused case was committed');
});

test('the staged checker accepts a test file whose names cite rows and whose fixtures come from the kit [C7]', () => {
  const box = hookedProject();
  writeFileSync(join(box.repo, 'test', 'clean.test.js'), "import { test } from 'node:test';\ntest('adds two numbers [C7]', () => {});\n");
  box.git(box.repo, 'add', 'test/clean.test.js');
  const done = stagedCheck(box);
  assert.equal(done.status, 0, done.stderr);
});

test('the staged test checks read nothing when no test file is staged, clause 2 [C7]', () => {
  const files = Array.from({ length: 20 }, (_, index) => `src/module-${index}.js`);
  const refuse = file => { throw new Error(`read ${file}`); };
  for (const check of STAGED_TEST_CHECKS) {
    assert.deepEqual(check.run({ root: REPO, files, staged: true, text: refuse, previous: refuse, read: refuse, sources: [], engineSources: [] }), [],
      `${check.name} scans no file`);
  }
});

test('the staged checker judges a 20-file commit under 2 s, clause 2 [C7]', () => {
  const box = hookedProject();
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  for (let index = 0; index < 10; index++) {
    writeFileSync(join(box.repo, 'src', `module-${index}.js`), `/** Module ${index}. */\nexport const value${index} = ${index};\n`);
    writeFileSync(join(box.repo, 'test', `module-${index}.test.js`), `import { test } from 'node:test';\ntest('module ${index} loads [C7]', () => {});\n`);
  }
  box.git(box.repo, 'add', '-A');
  assert.equal(box.git(box.repo, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).length, 20);
  const started = performance.now();
  const done = stagedCheck(box);
  const elapsed = performance.now() - started;
  assert.equal(done.status, 0, done.stderr);
  assert.ok(elapsed < 2000, `staged check took ${Math.round(elapsed)} ms`); // budget: approved item #3683 measured ceiling, 2 s on a 20-file commit
});
