/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/** A name-filtered landing gate shards like any other landing gate, and a red in any shard still fails it [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { describe } from 'node:test';
import { test } from 'node:test';
import { copyPackageFiles } from '../../../../runners/index.js';
import { packageFiles } from '../../../../runners/index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../../../gate/tests/fixtures/child.js';

const SOURCE = resolve(import.meta.dirname, '../../../../..');
/** Two files, two shards: the fan-out is under test, not its volume, and every shard is a whole node process. */
const NAMES = ['a', 'b'];

/** What a gate child never loads: the apps and packages its entry's import graph does not reach, and every package's own tests and journeys (unreached by any source file). A smaller tree is a faster copy, add, commit, pack and per-shard checkout [C7]. */
const UNUSED = /^(?:apps\/(?:view|relay|runner)\/|packages\/(?:api|blueprints|board|flakes|github|health|land|mcp|moves|rigor|search|sentinels|shouts|sync)\/|(?:apps|packages)\/[^/]+\/(?:tests|journeys)\/)/u;

let template = null;
const T0 = Date.now();
/** A phase mark on stderr, in seconds since the file loaded: it shows where the wait is. */
const mark = label => process.stderr.write(`[filter ${((Date.now() - T0) / 1000).toFixed(1)}s] ${label}\n`);
after(() => { if (template) rmSync(template, { recursive: true, force: true }); });

/** The environment a gate child runs in, for a project folder. */
function projectEnv(dir) {
  const home = join(dir, 'home');
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: join(home, '.pullboard'), GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PULLBOARD_LANDING_RUN: '1' };
  for (const key of Object.keys(env)) if (/^PULLBOARD_(GATE_SLOT|BROWSER_SLOT|LANDING_SHARD)/u.test(key) || key === 'NODE_TEST_CONTEXT') delete env[key];
  return env;
}

/** The text of one fixture test file: a target case and an unrelated one; the target is red or slow when asked. */
function fixtureTest(name, redFile, slowFile) {
  return `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n`
    + (name === slowFile ? `test('target ${name} [C7]', () => new Promise(done => setTimeout(done, 6_000)));\n`
      : `test('target ${name} [C7]', () => assert.equal(${JSON.stringify(name === redFile ? 'red' : 'green')}, 'green'));\n`)
    + `test('unrelated ${name} [C7]', () => assert.fail('the name filter must skip this case'));\n`;
}

/** The project every case copies: built once per file, because copying the package and committing it costs seconds per case. */
function projectTemplate() {
  if (template) return template;
  mark('template build start');
  const dir = privateFixtureFiles('pullboard-name-shards-template-').root;
  template = dir;
  const repo = join(dir, 'repo'), home = join(dir, 'home');
  mkdirSync(join(repo, 'test'), { recursive: true });
  mkdirSync(join(home, '.pullboard'), { recursive: true });
  writeFileSync(join(home, '.pullboard', 'settings.json'), JSON.stringify({ gateSlots: 3, browserSlots: 1 }));
  // The gate under test runs from source, never from the shipped test files: leaving them out shrinks the copy, the commit, and every shard's checkout and cleanup.
  // The fixture has no cell plan: with one, every shard's gate also builds the accepted inventory of the whole source tree, work a name filter never exercises [C7].
  // Docs and the archived board history (22 MB of the 41 MB) are never read by a gate child, and every case and shard copies the project.
  copyPackageFiles(SOURCE, repo, { files: packageFiles(SOURCE).filter(file => !/\.test\.js$/u.test(file) && file !== 'packages/codemap/data/plan/cells.json' && !/^(?:docs|packages\/state\/data)\//u.test(file) && !UNUSED.test(file)) });
  for (const name of NAMES) writeFileSync(join(repo, `test/${name}.test.js`), fixtureTest(name));
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node apps/cli/src/io/run/tests.js', landingShards: 2 }));
  const env = projectEnv(dir);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'test: name-filtered shards fixture']]) execFileSync('git', args, { cwd: repo, env });
  execFileSync('git', ['gc', '-q', '--prune=now'], { cwd: repo, env }); // One pack file instead of thousands of loose objects: every case copies this tree.
  mark('template build done');
  return dir;
}

/** Copy the template to a new path: a copy-on-write clone where the volume has them, whose cost does not grow with the file count; a plain recursive copy otherwise. Async, so the cases copy side by side. */
async function cloneTree(from, to) {
  rmSync(to, { recursive: true, force: true }); // The private root's empty directory: cp creates the destination itself.
  for (const flags of process.platform === 'darwin' ? [['-cRp'], ['-Rp']] : [['-Rp']]) {
    const status = await new Promise(done => spawn('cp', [...flags, from, to], { stdio: 'ignore' }).on('error', () => done(1)).on('close', done));
    if (status === 0) return;
    rmSync(to, { recursive: true, force: true });
  }
  await cp(from, to, { recursive: true });
}

/** A private project with two test files, each holding a target case and an unrelated one, and landingShards 2: a copy of the template, with one file made red or slow when asked. */
async function project(t, redFile = null, slowFile = null) {
  const dir = privateFixtureFiles('pullboard-name-shards-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await cloneTree(projectTemplate(), dir);
  const repo = join(dir, 'repo'), env = projectEnv(dir);
  if (redFile || slowFile) {
    for (const name of [redFile, slowFile].filter(Boolean)) writeFileSync(join(repo, `test/${name}.test.js`), fixtureTest(name, redFile, slowFile));
    for (const args of [['add', '.'], ['commit', '-q', '-m', 'test: a red or slow case']]) execFileSync('git', args, { cwd: repo, env });
  }
  return { repo, env };
}

/** Run the landing gate with a name filter over all two files. */
async function gate(box, pattern = '^target', extra = [], files = NAMES.map(name => `test/${name}.test.js`)) {
  const label = `gate ${pattern} ${extra.join(' ')}`;
  mark(`${label} start`);
  const run = await runFixtureChildAsync(process.execPath, ['apps/cli/src/io/run/tests.js', '--test-name-pattern', pattern, ...extra, ...files],
    { cwd: box.repo, env: box.env, signal: AbortSignal.timeout(240_000) });
  mark(`${label} done`);
  return run;
}

/** The cases share nothing but the read-only template, so they run side by side; each gate child is async for that. */
describe('name-filtered landing shards [C7]', { concurrency: 10 }, () => {
test('landing.filter.a-name-filtered-landing-gate-with: clause 1: a name-filtered landing gate with landingShards 2 runs as two shards, each with the name filter [C7]', async t => {
  // Overlapping globs ride the same gate: each of the two target cases still runs once.
  const run = await gate(await project(t), '^target', [], ['test/*.test.js', 'test/[ab].test.js']);
  assert.equal(run.status, 0, run.context ?? run.stdout + run.stderr);
  assert.match(run.stdout, /# landing shards: 2 /u, 'two shards, not one local pass');
  const cases = [...run.stdout.matchAll(/^# landing selected cases (\d+)$/gmu)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(cases, 2, 'every shard ran only its target case, and overlapping globs run each of the two target cases once');
});

test('landing.filter.a-red-in-any-name-filtered: clause 2: a red in any name-filtered shard fails the gate and names the test; a filter matching nothing fails too [C7]', async t => {
  const [red, none] = await Promise.all([project(t, 'b').then(box => gate(box)), project(t).then(box => gate(box, '^no such case$'))]);
  assert.notEqual(red.status, 0);
  assert.match(red.stdout + red.stderr, /target b/u, 'the failing case is named');
  assert.match(red.stdout, /# landing result: red/u);
  assert.notEqual(none.status, 0);
  assert.match(none.stdout + none.stderr, /NO_TESTS_MATCHED/u);
});

test('landing.filter.duplicate-paths-run-once-and-every: clause 1: duplicate paths run once, and every selector option reaches every shard [C7]', async t => {
  const box = await project(t);
  const files = [...NAMES.map(name => `test/${name}.test.js`), 'test/a.test.js', './test/b.test.js'];
  const run = await gate(box, '^target', ['--test-skip-pattern', 'target [b] '], files);
  assert.equal(run.status, 0, run.context ?? run.stdout + run.stderr);
  const cases = [...run.stdout.matchAll(/^# landing selected cases (\d+)$/gmu)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(cases, 1, 'each target runs once despite duplicate paths, and the skip pattern drops b in its shard');
  const { landingShardOptions } = await import('../../../../gate/index.js');
  assert.deepEqual(landingShardOptions(['--test-name-pattern', 'x', 'test/a.test.js', '--test-skip-pattern=y', '--test-timeout', '5', '--test-reporter=tap', '--', 'test/b.test.js'],
    arg => ['--test-name-pattern', '--test-timeout'].includes(arg)),
  ['--test-name-pattern', 'x', '--test-skip-pattern=y', '--test-timeout', '5', '--test-reporter=tap'], 'every option as written; only files drop');
});

test('landing.filter.equivalent-spellings-of-one-test-file: clause 1: equivalent spellings of one test file plan onto one shard once [C7]', async () => {
  const { planLandingShards } = await import('../../../index.js');
  const root = '/repo';
  const spellings = ['test/a.test.js', './test/a.test.js', 'test/../test/a.test.js', 'test//a.test.js', 'test/./a.test.js', '/repo/test/a.test.js', 'test/b.test.js', 'test/x/../b.test.js'];
  const plan = planLandingShards(spellings, 6, { 'test/a.test.js': 900 }, root);
  assert.deepEqual(plan.map(shard => shard.files), [['test/a.test.js'], ['test/b.test.js']], 'each file is planned once, under its first spelling');
  assert.equal(plan[0].weight, 900, 'the recorded time follows the file through any spelling');
  assert.equal(planLandingShards(['test/../test/a.test.js', 'test/a.test.js'], 2).flatMap(shard => shard.files).length, 1, 'no root still folds relative spellings');
});

test('landing.filter.the-fan-out-expands-globs-and: clause 1: the fan-out expands globs and folds spellings into one file list [C7]', async t => {
  const { landingFanOutFiles, optionTakesValue } = await import('../../../../gate/index.js');
  const box = await project(t);
  assert.deepEqual(landingFanOutFiles(['test/a.test.js', './test/a.test.js', 'test/b.test.js'], ['--test-name-pattern', 'x'], box.repo, optionTakesValue),
    ['test/a.test.js', 'test/b.test.js'], 'each file once');
  assert.deepEqual(landingFanOutFiles(['test/[ab].test.js', 'test/*.test.js', `${box.repo}/test/b.test.js`], [], box.repo, optionTakesValue),
    NAMES.map(name => `test/${name}.test.js`), 'globs expand to files, overlaps and absolute spellings fold');
  assert.deepEqual(landingFanOutFiles(['test/a.test.js'], ['--test-name-pattern', '--test-shard=2/2'], box.repo, optionTakesValue), ['test/a.test.js'],
    'a pattern value that looks like a shard flag is a pattern');
});

test('landing.filter.a-name-filtered-landing-that-also: clause 1: a name-filtered landing that also carries a caller shard flag refuses USAGE and never fans out [C7]', async t => {
  const { landingFanOutFiles, optionTakesValue } = await import('../../../../gate/index.js');
  const box = await project(t);
  for (const args of [['--test-shard=1/2'], ['--test-shard', '2/2'], ['--test-shard'], ['--test-name-pattern', 'x', '--test-shard'], ['--shard=1/2']]) {
    assert.throws(() => landingFanOutFiles(['test/a.test.js'], args, box.repo, optionTakesValue), error => error.code === 'USAGE', JSON.stringify(args));
  }
  // The pure planner above refuses both spellings; one real gate proves the refusal reaches the command, since each gate is a whole node process.
  const run = await gate(box, '^target', ['--shard', '1/2']);
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /USAGE/u);
  assert.doesNotMatch(run.stdout, /# landing selected cases/u, 'no shard ran');
});

test('landing.filter.a-selector-option-missing-its-value: clause 1: a selector option missing its value refuses as the unsharded run does, and never fans out [C7]', async t => {
  const box = await project(t);
  const gates = ['--test-skip-pattern', '--test-name-pattern'].map(option => gate(box, '^target', [], [...NAMES.map(name => `test/${name}.test.js`), option]));
  for (const [index, option] of ['--test-skip-pattern', '--test-name-pattern'].entries()) {
    const run = await gates[index];
    assert.notEqual(run.status, 0, option);
    assert.match(run.stdout + run.stderr, new RegExp(`${option} requires a value`, 'u'));
    assert.doesNotMatch(run.stdout, /# landing selected cases/u, 'no shard ran');
  }
});

test('landing.filter.a-caller-test-timeout-reaches-every: clause 2: a caller --test-timeout reaches every shard, so a case that times out unsharded fails the sharded gate [C7]', async t => {
  const extra = ['--test-timeout=3000'];
  const run = await gate(await project(t, null, 'b'), '^target', extra);
  assert.notEqual(run.status, 0, `${extra.join(' ')}: ${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /# landing shards: 2 /u, 'the run was sharded');
  assert.match(run.stdout + run.stderr, /target b|b\.test\.js/u, 'the timed-out test is named');
  assert.match(run.stdout + run.stderr, /timed out after 3000ms/u, 'the caller timeout applied');
  assert.match(run.stdout, /# landing result: red/u);
});

test('landing.filter.a-name-filter-with-no-file: clause 1: a name filter with no file arguments fans out, and its collection never claims the full suite [C7]', async t => {
  const box = await project(t);
  // Only the two fixture files stay tracked tests, so the unfiltered default suite is exactly them.
  const packaged = execFileSync('git', ['ls-files', '*.test.js'], { cwd: box.repo, env: box.env, encoding: 'utf8' }).split('\n').filter(file => file && !file.startsWith('test/'));
  if (packaged.length) execFileSync('git', ['rm', '-q', '--', ...packaged], { cwd: box.repo, env: box.env });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'test: only the fixture tests'], { cwd: box.repo, env: box.env });
  const run = await gate({ ...box, env: { ...box.env, PULLBOARD_LANDING_COLLECT_ALL: '1', PULLBOARD_LANDING_COLLECTION_ID: 'filtered-suite' } }, '^target', [], []);
  assert.equal(run.status, 0, run.context ?? run.stdout + run.stderr);
  assert.match(run.stdout, /# landing shards: \d+ /u, 'the run was sharded');
  const suite = [...run.stdout.matchAll(/^# pullboard-landing-collection (\{.*\})$/gmu)].map(match => JSON.parse(match[1])).find(frame => frame.scope === 'suite');
  assert.ok(suite, 'the suite collection frame printed');
  assert.equal(suite.full, false, 'a filtered run is never a full-suite collection');
});

test('landing.filter.files-after-stay-files-in-every: clause 1: files after -- stay files in every shard, under the caller spelling, even one named like an option [C7]', async t => {
  const box = await project(t);
  writeFileSync(join(box.repo, '-case.test.js'), "import { test } from 'node:test';\ntest('target dash [C7]', () => {});\n");
  execFileSync('git', ['add', '--', '-case.test.js'], { cwd: box.repo, env: box.env });
  execFileSync('git', ['commit', '-q', '-m', 'test: a file named like an option'], { cwd: box.repo, env: box.env });
  const run = await gate(box, '^target', [], ['./test/a.test.js', 'test/b.test.js', '--', '-case.test.js']);
  assert.equal(run.status, 0, run.context ?? run.stdout + run.stderr);
  assert.match(run.stdout, /# landing shards: 2 /u, 'three files fold onto the two shards');
  assert.equal([...run.stdout.matchAll(/^# landing selected cases (\d+)$/gmu)].reduce((sum, match) => sum + Number(match[1]), 0), 3,
    'the dash-named file ran as a test file, not an option');
  const { landingFanOutFiles, optionTakesValue } = await import('../../../../gate/index.js');
  assert.deepEqual(landingFanOutFiles(['./test/a.test.js', 'test/a.test.js', '-case.test.js', `${box.repo}/test/b.test.js`], [], box.repo, optionTakesValue),
    ['./test/a.test.js', '-case.test.js', 'test/b.test.js'], 'the first spelling is kept; only an absolute one becomes repository-relative');
});
test('landing.filter.the-fixture-repo-carries-no-cell: clause 1: the fixture repo carries no cell plan index, so no gate child builds the full-tree inventory [C7]', async t => {
  const box = await project(t);
  assert.equal(existsSync(join(box.repo, 'packages/codemap/data/plan/cells.json')), false);
  assert.equal(existsSync(join(box.repo, 'packages/codemap/index.js')), true, 'the rest of the source tree is still copied');
});
});
