/**
 * Shared kit for the pre-commit static check journeys: a project that commits through the repository's own hook, and the
 * staged checker run without committing [C7].
 *
 * Why shared: each journey builds its own project (init plus real hook commits, tens of seconds on a loaded runner), so
 * the journeys are split across files to stay under the per-file budget.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createE2eHelpers } from '../e2e.js';

export const helpers = createE2eHelpers();

export const REPO = join(import.meta.dirname, '../../../../..');
const SCRIPTS = 'packages/gate/src/io/changed/scripts';
const CHECKS = join(REPO, SCRIPTS);
const NODE_FLAGS = ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'];

/** Seed the native CLI tree before init installs its pre-commit hook; the caller passes the runners cell's copy, since fixtures hold no cross-cell imports. */
function runtimeSeededBeforeInit(copyPackageFiles) {
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
export const CASES = [
  ['apps/cli/journeys/fact/precommit-tempdir.test.js', "import { mkdtempSync } from 'node:fs';\nexport const dir = mkdtempSync('fixture-');\n", /tempdir: creates a temporary directory/u],
  ['apps/cli/journeys/fact/precommit-model.test.js', "process.env.PULLBOARD_MODEL = 'sonnet';\n", /model: passes a literal model string/u],
  ['apps/cli/journeys/resume/board.test.js', "export const board = openBoard('board.db');\n", /raw-board: opens a board or adds an item in process/u],
  ['apps/cli/journeys/fact/precommit-name.test.js', "import { test } from 'node:test';\ntest('adds two numbers', () => {});\n", /test name has no spec row id: adds two numbers/u],
];

/**
 * A project that commits through the repository's own pre-commit hook. Its staged checker delegates to this checkout's
 * packages/gate/src/io/changed/scripts/static.js, and its ceilings files are committed, as in the real repository.
 * The stub also re-exports stagedHookFailures, since the hook now imports the named check in process (#5719).
 */
export function hookedProject(copyPackageFiles) {
  const box = helpers.project('true', runtimeSeededBeforeInit(copyPackageFiles), { withWorktree: false });
  mkdirSync(join(box.repo, 'packages/gate/data/baselines'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/gate/data/tests'), { recursive: true });
  mkdirSync(join(box.repo, SCRIPTS), { recursive: true });
  mkdirSync(join(box.repo, '.githooks'), { recursive: true });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  mkdirSync(join(box.repo, 'apps/cli/journeys/resume'), { recursive: true });
  mkdirSync(join(box.repo, 'apps/cli/journeys/fact'), { recursive: true });
  copyFileSync(join(REPO, 'packages/gate/data/baselines/test-waits-baseline.json'), join(box.repo, 'packages/gate/data/baselines/test-waits-baseline.json'));
  writeFileSync(join(box.repo, 'packages/gate/data/tests/test-fixtures.json'), '{}\n');
  // The layout ratchet judges the box's own baseline: the real counts, with the root entries init writes (.agents, .claude, .codex, .mcp.json) accepted.
  mkdirSync(join(box.repo, 'packages/codemap/data/baselines'), { recursive: true });
  const layout = JSON.parse(readFileSync(join(REPO, 'packages/codemap/data/baselines/layout.json'), 'utf8'));
  layout.rules['root-entry'] = 4;
  writeFileSync(join(box.repo, 'packages/codemap/data/baselines/layout.json'), `${JSON.stringify(layout, null, 2)}\n`);
  writeFileSync(join(box.repo, SCRIPTS, 'static.js'), [
    `import { stagedHookFailures } from ${JSON.stringify(pathToFileURL(join(CHECKS, 'static.js')).href)};`,
    "import { pathToFileURL } from 'node:url';",
    'export { stagedHookFailures };',
    'if (import.meta.url === pathToFileURL(process.argv[1] ?? \'\').href) {',
    '  const started = performance.now();',
    '  const failures = stagedHookFailures(process.cwd());',
    "  process.stdout.write(`staged-check-ms ${Math.round(performance.now() - started)}\\n`);",
    "  if (failures.length) { process.stderr.write(failures.join('\\n') + '\\n'); process.exitCode = 1; }",
    '}', ''].join('\n'));
  copyFileSync(join(REPO, '.githooks', 'pre-commit'), join(box.repo, '.githooks', 'pre-commit'));
  chmodSync(join(box.repo, '.githooks', 'pre-commit'), 0o755);
  box.git(box.repo, 'add', '--', '.githooks/pre-commit', 'packages/gate/data/baselines/test-waits-baseline.json',
    'packages/gate/data/tests/test-fixtures.json', `${SCRIPTS}/static.js`, 'packages/codemap/data/baselines/layout.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: record the static ceilings and the repository hook');
  box.git(box.repo, 'config', 'core.hooksPath', '.githooks');
  return box;
}

/** Run the staged checker the hook runs, without committing. */
export function stagedCheck(box) {
  return spawnSync(process.execPath, [...NODE_FLAGS, join(box.repo, SCRIPTS, 'static.js')], { cwd: box.repo, env: box.env, encoding: 'utf8' });
}

/** Stage each case in turn and assert the gate, the staged checker and the real hook print the same refusal line, committing none. */
export function assertHookRefuses(box, cases, { fixtureProblems, testNameProblems }) {
  for (const [file, source] of cases) writeFileSync(join(box.repo, file), source);
  const gate = [
    ...fixtureProblems(box.repo, join(box.repo, 'packages/gate/data/tests/test-fixtures.json'), { base: null }),
    ...testNameProblems(box.repo),
  ].map(row => `${row.path}:${row.line}: ${row.text}`);
  for (const [file, , message] of cases) {
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
}
