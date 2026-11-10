/** @pullboard-test-input source-tree */
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
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureProblems } from '../../../../packages/gate/src/io/test/fixtures.js';
import { testNameProblems } from '../../../../packages/gate/src/io/test/names.js';
import { STAGED_TEST_CHECKS } from '../../../../packages/gate/src/io/changed/scripts/static.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';

const helpers = createE2eHelpers();
after(() => helpers.cleanup());

const REPO = join(import.meta.dirname, '../../../..');
const CHECKS = join(REPO, 'packages/gate/src/io/changed/scripts');
const NODE_FLAGS = ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'];

/** Seed the native CLI tree before init installs its pre-commit hook. */
function runtimeSeededBeforeInit() {
  const box = helpers.sandbox();
  const run = box.run;
  box.run = (repo, ...args) => {
    if (args[0] === 'init') {
      copyPackageFiles(REPO, repo);
      box.git(repo, 'add', '-A');
      box.git(repo, 'commit', '-q', '-m', 'chore: seed native hook runtime');
    }
    return run(repo, ...args);
  };
  return box;
}

/** The four static reds that cost the most gates on 7 Nov, each alone in its own test file. */
const CASES = [
  ['apps/cli/journeys/fact/precommit-tempdir.test.js', "import { mkdtempSync } from 'node:fs';\nexport const dir = mkdtempSync('fixture-');\n", /tempdir: creates a temporary directory/u],
  ['apps/cli/journeys/fact/precommit-model.test.js', "process.env.PULLBOARD_MODEL = 'sonnet';\n", /model: passes a literal model string/u],
  ['apps/cli/journeys/resume/board.test.js', "export const board = openBoard('board.db');\n", /raw-board: opens a board or adds an item in process/u],
  ['apps/cli/journeys/fact/precommit-name.test.js', "import { test } from 'node:test';\ntest('adds two numbers', () => {});\n", /test name has no spec row id: adds two numbers/u],
];

/**
 * A project that commits through the repository's own pre-commit hook. Its staged checker delegates to this checkout's
 * packages/gate/src/io/changed/scripts/static.js, and its ceilings files are committed, as in the real repository.
 */
function hookedProject() {
  const box = helpers.project('true', runtimeSeededBeforeInit(), { withWorktree: false });
  mkdirSync(join(box.repo, 'packages/gate/data/baselines'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/gate/data/tests'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/gate/src/io/changed/scripts'), { recursive: true });
  mkdirSync(join(box.repo, '.githooks'), { recursive: true });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  mkdirSync(join(box.repo, 'apps/cli/journeys/resume'), { recursive: true });
  mkdirSync(join(box.repo, 'apps/cli/journeys/fact'), { recursive: true });
  copyFileSync(join(REPO, 'packages/gate/data/baselines/test-waits-baseline.json'), join(box.repo, 'packages/gate/data/baselines/test-waits-baseline.json'));
  writeFileSync(join(box.repo, 'packages/gate/data/tests/test-fixtures.json'), '{}\n');
  writeFileSync(join(box.repo, 'packages/gate/src/io/changed/scripts/static.js'), [
    `import { stagedHookFailures } from ${JSON.stringify(pathToFileURL(join(CHECKS, 'static.js')).href)};`,
    'const failures = stagedHookFailures(process.cwd());',
    "if (failures.length) { process.stderr.write(failures.join('\\n') + '\\n'); process.exitCode = 1; }", ''].join('\n'));
  copyFileSync(join(REPO, '.githooks', 'pre-commit'), join(box.repo, '.githooks', 'pre-commit'));
  chmodSync(join(box.repo, '.githooks', 'pre-commit'), 0o755);
  box.git(box.repo, 'add', '--', '.githooks/pre-commit', 'packages/gate/data/baselines/test-waits-baseline.json',
    'packages/gate/data/tests/test-fixtures.json', 'packages/gate/src/io/changed/scripts/static.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: record the static ceilings and the repository hook');
  box.git(box.repo, 'config', 'core.hooksPath', '.githooks');
  return box;
}

/** Run the staged checker the hook runs, without committing. */
function stagedCheck(box) {
  return spawnSync(process.execPath, [...NODE_FLAGS, join(box.repo, 'packages/gate/src/io/changed/scripts/static.js')], { cwd: box.repo, env: box.env, encoding: 'utf8' });
}

test('the real pre-commit hook refuses a temp dir, a model literal, a raw board and an unnamed test with the gate static stage messages, clause 1 [C7]', () => {
  const box = hookedProject();
  for (const [file, source] of CASES) writeFileSync(join(box.repo, file), source);
  const gate = [
    ...fixtureProblems(box.repo, join(box.repo, 'packages/gate/data/tests/test-fixtures.json'), { base: null }),
    ...testNameProblems(box.repo),
  ].map(row => `${row.path}:${row.line}: ${row.text}`);
  for (const [file, , message] of CASES) {
    const printed = gate.filter(line => line.startsWith(`${file}:`));
    assert.equal(printed.length, 1, `the gate prints one red for ${file}: ${gate.join('\n')}`);
    assert.match(printed[0], message);
    box.git(box.repo, 'add', file);
    const staged = stagedCheck(box);
    assert.notEqual(staged.status, 0, `the staged checker refuses ${file}: ${staged.stderr}`);
    assert.ok(staged.stderr.includes(printed[0]), `the staged checker prints the gate line ${printed[0]}`);
    const commit = box.tryGit(box.repo, 'commit', '-q', '-m', 'test: add a fixture case [G1]');
    const output = `${commit.stderr ?? commit.err ?? ''}${commit.stdout ?? commit.out ?? ''}`;
    assert.notEqual(commit.status ?? commit.code, 0, `the hook refuses ${file}`);
    assert.ok(output.includes(printed[0]), `the hook prints the gate line ${printed[0]}, got:\n${output}`);
    box.git(box.repo, 'restore', '--staged', '--', file);
  }
  assert.match(box.git(box.repo, 'log', '-1', '--format=%s'), /record the static ceilings/u, 'no refused case was committed');
});

test('the staged checker accepts a test file whose names cite rows and whose fixtures come from the kit [C7]', () => {
  const box = hookedProject();
  writeFileSync(join(box.repo, 'test/clean.test.js'), "import { test } from 'node:test';\ntest('adds two numbers [C7]', () => {});\n");
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
    writeFileSync(join(box.repo, `src/module-${index}.js`), `/** Module ${index}. */\nconst value${index} = ${index};\nexport { value${index} };\n`);
    writeFileSync(join(box.repo, `test/module-${index}.test.js`), `import { test } from 'node:test';\ntest('module ${index} loads [C7]', () => {});\n`);
  }
  box.git(box.repo, 'add', '-A', '--', 'src', 'test');
  assert.equal(box.git(box.repo, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).length, 20);
  const started = performance.now();
  const done = stagedCheck(box);
  const elapsed = performance.now() - started;
  assert.equal(done.status, 0, done.stderr);
  assert.ok(elapsed < 2000, `staged check took ${Math.round(elapsed)} ms`); // budget: approved item #3683 measured ceiling, 2 s on a 20-file commit
});
