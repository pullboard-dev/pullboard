/** @pullboard-test-input source-cell apps/cli packages/runners */
/** Exercise native test-file sharding and discovery through the production test runner [C7]. */
import { copyRunnerPackage } from '../../fixtures/package.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { stageFixtureTests } from '../../fixtures/tests.js';
import { makeShardFixture } from '../../fixtures/landing-run.js';

const runner = fileURLToPath(new URL('../../../../../apps/cli/src/io/run/tests.js', import.meta.url));
/** Build a copied production runner with tracked, ignored, and untracked test files. */
function makeTrackedSelectionFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-tracked-tests-')));
  const bin = join(root, 'bin');
  const source = join(root, 'src');
  const tests = join(root, 'test');
  const scratch = join(root, 'scratch');
  const expected = ['tracked', 'docs-esm', 'dot-suffix'];
  mkdirSync(bin);
  mkdirSync(tests);
  mkdirSync(scratch);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, '.gitignore'), 'scratch/\n');
  copyRunnerPackage(resolve(import.meta.dirname, '../../../../..'), root);
  const capture = join(root, 'selected-files.txt');
  const trackedSources = new Map([
    ['test/tracked.test.js', trackedFixtureSource('tracked')],
    ['docs/guide.test.mjs', trackedFixtureSource('docs-esm')],
    ['prefix.test.js', trackedFixtureSource('dot-suffix')],
    ['prefix-test.cjs', trackedFixtureSource('dash-suffix')],
    ['prefix_test.mjs', trackedFixtureSource('underscore-suffix')],
    ['test-launch.js', trackedFixtureSource('test-prefix')],
    ['test.js', trackedFixtureSource('test-name')],
  ]);
  for (const [path, sourceText] of trackedSources) {
    writeFileSync(join(root, path), sourceText);
  }
  writeFileSync(join(root, 'tracked.spec.js'), `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Fail if a tracked but non-default filename is selected. */
function failIfNonDefaultRuns() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, 'non-default\\n'); throw new Error('non-default test was executed'); }
test('tracked spec file must not run [C7]', failIfNonDefaultRuns);
`);
  writeFileSync(join(tests, 'untracked.test.js'), `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Fail if the runner discovers an untracked test from the worktree. */
function failIfUntrackedRuns() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, 'untracked\\n'); throw new Error('untracked test was executed'); }
test('untracked test must not run [C7]', failIfUntrackedRuns);
`);
  writeFileSync(join(scratch, 'ignored.test.js'), `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Fail if the runner discovers an ignored test from scratch storage. */
function failIfIgnoredRuns() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, 'ignored\\n'); throw new Error('ignored test was executed'); }
test('ignored test must not run [C7]', failIfIgnoredRuns);
`);
  stageFixtureTests(root, ['.gitignore', ...trackedSources.keys(), 'tracked.spec.js']);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, runner: join(root, 'apps/cli/src/io/run/tests.js'), capture, expected };
}

/** Create a small ESM or CommonJS test that records its discovery-pattern label. */
function trackedFixtureSource(label) {
  if (label === 'dash-suffix') {
    return `const { appendFileSync } = require('node:fs');
const { test } = require('node:test');
/** Record one tracked default-pattern match. */
function recordTrackedMatch() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, '${label}\\n'); }
test('tracked ${label} pattern ran [C7]', recordTrackedMatch);
`;
  }
  return `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Record one tracked default-pattern match. */
function recordTrackedMatch() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, '${label}\\n'); }
test('tracked ${label} pattern ran [C7]', recordTrackedMatch);
`;
}

/** Ensure default discovery runs tracked tests but never filesystem-only copies. */
function trackedSelectionTest(t) {
  const fixture = makeTrackedSelectionFixture(t);
  assert.equal(execFileSync('git', ['check-ignore', '-q', 'scratch/ignored.test.js'], { cwd: fixture.root }).length, 0,
    'the failing scratch test is actually ignored by Git');
  const tracked = execFileSync('git', ['ls-files'], { cwd: fixture.root, encoding: 'utf8' }).trim().split(/\r?\n/u);
  assert.ok(tracked.includes('.gitignore') && tracked.includes('tracked.spec.js'), 'the non-default and ignore control files are tracked');
  assert.equal(tracked.length, 9, 'all pattern cases and non-default controls are tracked');
  // A runner call naming no file says --all, since only a stage-marked caller may run the whole suite bare (#5913).
  const result = runFixtureChild(process.execPath, [fixture.runner, '--all'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_TRACKED_CAPTURE: fixture.capture },
  });
  assert.equal(result.status, 0,
    `${result.context}\nexecuted files: ${readFileSync(fixture.capture, 'utf8')}`);
  for (const label of fixture.expected) assert.match(result.stdout, new RegExp(`ok [0-9]+ - tracked .*${label}.* pattern ran \\[C7\\]`, 'u'));
  assert.doesNotMatch(`${result.stdout}\n${result.stderr ?? ''}`, /ignored test was executed|untracked test was executed|non-default test was executed/u);
  assert.deepEqual(readFileSync(fixture.capture, 'utf8').trim().split(/\r?\n/u).sort(),
    fixture.expected.toSorted(),
    'only repository test entry names run exactly once');

  writeFileSync(fixture.capture, '');
  const filtered = runFixtureChild(process.execPath, [fixture.runner, '--all', '--test-name-pattern', 'docs-esm'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_TRACKED_CAPTURE: fixture.capture },
  });
  assert.equal(filtered.status, 0, filtered.context);
  assert.match(filtered.stdout, /ok [0-9]+ - tracked docs-esm pattern ran \[C7\]/u,
    'name filters still apply to the tracked default list');
  assert.equal(readFileSync(fixture.capture, 'utf8'), 'docs-esm\n');

  const explicit = runFixtureChild(process.execPath, [fixture.runner, 'test/untracked.test.js'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_TRACKED_CAPTURE: fixture.capture },
  });
  assert.equal(explicit.status, 1, explicit.context);
  assert.match(explicit.stdout, /not ok [0-9]+ - untracked test must not run \[C7\]/u,
    'an explicitly named fixture remains runnable even though it is untracked');
}

test('the runner skips test files git does not track [C7]', trackedSelectionTest);

/** Keep perf-shaped helpers importable without launching their standalone entry points. */
function onlyTestEntriesTest(t) {
  const fixture = makeShardFixture(t);
  const env = { ...process.env, PULLBOARD_SHARD_CAPTURE: fixture.capture,
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  /** Write one tracked fixture input with its real repository-relative path. */
  const put = (path, body) => {
    mkdirSync(dirname(join(fixture.root, path)), { recursive: true });
    writeFileSync(join(fixture.root, path), body);
  };
  /** Commit the fixture entries in a real Git repository. */
  const commit = () => {
    runFixtureGit(['add', '-A'], { cwd: fixture.root, env });
    runFixtureGit(['commit', '-qm', 'chore: discovery fixture'], { cwd: fixture.root, env });
    return runFixtureGit(['rev-parse', 'HEAD'], { cwd: fixture.root, env }).trim();
  };
  const helpers = ['apps/cli/tests/fixtures/cockpit/perf/run.mjs', 'apps/cli/tests/fixtures/cockpit/perf/generate.mjs',
    'apps/cli/tests/fixtures/cockpit/harness.js', 'apps/cli/tests/fixtures/view/link.js'];
  put('.gitignore', 'selected-files.txt\n');
  for (const path of helpers) put(path, `import { fileURLToPath } from 'node:url';
export const value = 42;
if (process.argv[1] === fileURLToPath(import.meta.url)) throw new Error('standalone helper: ${path}');
`);
  put('apps/cli/journeys/init/perf.test.js', `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
import { value as run } from '../../tests/fixtures/cockpit/perf/run.mjs';
import { value as generate } from '../../tests/fixtures/cockpit/perf/generate.mjs';
import { value as fixture } from '../../tests/fixtures/cockpit/harness.js';
import { value as link } from '../../tests/fixtures/view/link.js';
/** Exercise every imported helper without its standalone workload. */
function importedHelpersWork() { assert.deepEqual([run, generate, fixture, link], [42,42,42,42]); appendFileSync(process.env.PULLBOARD_SHARD_CAPTURE, 'cockpit/perf.test.js\\n'); }
test('perf helpers remain importable [C7]', importedHelpersWork);
`);
  put('docs/guide.test.mjs', "import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\n/** Exercise a named documentation test entry. */\nfunction guide() { appendFileSync(process.env.PULLBOARD_SHARD_CAPTURE, 'docs/guide.test.mjs\\n'); }\ntest('documentation test entry [C7]', guide);\n");
  put('test/tree-reader.test.js', "/** @pullboard-test-input test-tree */\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PULLBOARD_SHARD_CAPTURE, 'tree-reader.test.js\\n');\n");
  put('apps/cli/tests/fixtures/cockpit/perf/README.md', '# Perf harness\n');
  commit();
  const discovered = runFixtureChild(process.execPath, [fixture.runner, '--all'], {
    cwd: fixture.root, encoding: 'utf8', env,
  });
  assert.equal(discovered.status, 0, `${discovered.context}\n${discovered.stdout}`);
  assert.doesNotMatch(discovered.stdout + discovered.stderr, /standalone helper:/u);
  assert.match(discovered.stdout, /ok [0-9]+ - perf helpers remain importable/u);
  assert.match(discovered.stdout, /ok [0-9]+ - documentation test entry/u);
  assert.deepEqual(readFileSync(fixture.capture, 'utf8').trim().split('\n').sort(),
    [...fixture.expected, 'cockpit/perf.test.js', 'docs/guide.test.mjs', 'tree-reader.test.js'].sort(),
    'each expected test entry executes once, including a file with only a tree-reader declaration');
  const entries = [...fixture.expected.map(name => `test/${name}`),
    'apps/cli/journeys/init/perf.test.js', 'docs/guide.test.mjs', 'test/tree-reader.test.js'];
  const before = runFixtureChild(process.execPath, [fixture.runner, ...entries, ...helpers], {
    cwd: fixture.root, encoding: 'utf8', env,
  });
  assert.equal(before.status, 1, 'the old broad file list launches the standalone-only helper controls');
  assert.match(before.stdout, /standalone helper:/u);
  const expectedCases = [...fixture.expected.map(name => `record ${name} [C7]`),
    'perf helpers remain importable [C7]', 'documentation test entry [C7]'].sort();
  /** Separate declared case titles from Node's synthetic path-only test-file records. */
  const declaredCases = output => [...output.matchAll(/^# Subtest: (.+)$/gmu)].map(match => match[1])
    .filter(name => ![...entries, ...helpers].some(path => name === path || name.endsWith('/' + path))).sort();
  assert.deepEqual(declaredCases(before.stdout), expectedCases, 'the old broad list runs every declared case');
  assert.deepEqual(declaredCases(discovered.stdout), expectedCases, 'test-only discovery preserves every declared case');
  const beforeTotal = Number(before.stdout.match(/^# tests (\d+)$/mu)?.[1]);
  const afterTotal = Number(discovered.stdout.match(/^# tests (\d+)$/mu)?.[1]);
  assert.equal(beforeTotal, afterTotal + helpers.length,
    'only the standalone helper-file records disappear from the raw TAP total');
  process.stderr.write(`fixture declared cases: before=${expectedCases.length}, after=${expectedCases.length}; raw TAP: before=${beforeTotal}, after=${afterTotal}; helper records removed=${helpers.length}\n`);
}

test('the suite runs only test files, not helpers or the perf harness [C7]', onlyTestEntriesTest);

/** Run the copied production runner and return the test filenames it actually executed. */
function runShardFixture(fixture, shard) {
  writeFileSync(fixture.capture, '');
  const args = [fixture.runner, '--all', ...(shard ? ['--shard', shard] : [])];
  const env = { ...process.env, PULLBOARD_SHARD_CAPTURE: fixture.capture };
  delete env.NODE_TEST_CONTEXT;
  delete env.PULLBOARD_GATE_SLOT_HELD;
  assert.equal(env.PULLBOARD_GATE_SLOT_HELD, undefined, 'the private default-run probe does not inherit an outer gate lease');
  const result = runFixtureChild(process.execPath, args, {
    cwd: fixture.root,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.context);
  return readFileSync(fixture.capture, 'utf8').trim().split('\n').filter(Boolean);
}

/** Prove the default run stays whole and all native shard selections partition files once. */
function shardsSplitTest(t) {
  const fixture = makeShardFixture(t);
  const unsharded = runShardFixture(fixture, null);
  assert.deepEqual([...unsharded].sort(), fixture.expected, 'without --shard every discovered file still runs');
  const shards = [];
  for (let index = 1; index <= 3; index += 1) {
    const selected = runShardFixture(fixture, `${index}/3`);
    assert.ok(selected.length > 0, `shard ${index}/3 runs fixture files`);
    shards.push(selected);
  }
  const allSelected = shards.flat();
  assert.deepEqual([...allSelected].sort(), fixture.expected, 'three native shards cover every discovered file');
  assert.equal(new Set(allSelected).size, fixture.expected.length, 'no test file appears in more than one shard');
}

test('shards split the test files with none twice and none missing [C7]', shardsSplitTest);

/** Keep plain temporary projects runnable without requiring a Git index. */
function outsideGitDiscoveryTest(t) {
  const fixture = makeShardFixture(t);
  rmSync(join(fixture.root, '.git'), { recursive: true, force: true });
  const selected = runShardFixture(fixture, null);
  assert.deepEqual([...selected].sort(), fixture.expected,
    'without a Git work tree Node still discovers and executes every fixture test');

  writeFileSync(fixture.capture, '');
  writeFileSync(join(fixture.root, '.git'), 'gitdir: missing-git-directory\n');
  const broken = runFixtureChild(process.execPath, [fixture.runner, '--all'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_SHARD_CAPTURE: fixture.capture },
  });
  assert.equal(broken.status, 1, broken.context);
  assert.match(broken.stderr, /could not list tracked test files/u,
    'a damaged checkout is refused rather than mistaken for an ordinary non-Git folder');
  assert.equal(readFileSync(fixture.capture, 'utf8'), '', 'no filesystem tests run after Git metadata fails');
}

test('the runner keeps native discovery outside a Git work tree [C7]', outsideGitDiscoveryTest);

/** Assert the production runner names malformed shard ranges and their expected form. */
function badShardTest() {
  const badValues = ['0/3', '4/3', '2', 'a/b'];
  for (const value of badValues) {
    const result = runFixtureChild(process.execPath, [runner, '--all', '--shard', value], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.context);
    assert.match(result.stderr, new RegExp(`invalid --shard value "${value}"`));
    assert.match(result.stderr, /expected <i>\/<n> with 1 <= i <= n/u);
  }
}

test('a bad shard is refused by name [C7]', badShardTest);
