/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/** A name-filtered landing gate shards like any other landing gate, and a red in any shard still fails it [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../../../../runners/index.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';

const SOURCE = resolve(import.meta.dirname, '../../../../..');
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f'];

/** A private project with six test files, each holding a target case and an unrelated one, and landingShards 6. */
function project(t, redFile = null, slowFile = null) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-name-shards-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), home = join(dir, 'home');
  mkdirSync(join(repo, 'test'), { recursive: true });
  mkdirSync(join(home, '.pullboard'), { recursive: true });
  writeFileSync(join(home, '.pullboard', 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 1 }));
  copyPackageFiles(SOURCE, repo);
  for (const name of NAMES) {
    writeFileSync(join(repo, `test/${name}.test.js`), `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n`
      + (name === slowFile ? `test('target ${name} [C7]', () => new Promise(done => setTimeout(done, 6_000)));\n`
        : `test('target ${name} [C7]', () => assert.equal(${JSON.stringify(name === redFile ? 'red' : 'green')}, 'green'));\n`)
      + `test('unrelated ${name} [C7]', () => assert.fail('the name filter must skip this case'));\n`);
  }
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node packages/gate/src/io/run/tests.js', landingShards: 6 }));
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: join(home, '.pullboard'), GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PULLBOARD_LANDING_RUN: '1' };
  for (const key of Object.keys(env)) if (/^PULLBOARD_(GATE_SLOT|BROWSER_SLOT|LANDING_SHARD)/u.test(key) || key === 'NODE_TEST_CONTEXT') delete env[key];
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'test: name-filtered shards fixture']]) execFileSync('git', args, { cwd: repo, env });
  return { repo, env };
}

/** Run the landing gate with a name filter over all six files. */
function gate(box, pattern = '^target', extra = [], files = NAMES.map(name => `test/${name}.test.js`)) {
  return runFixtureChild(process.execPath, ['packages/gate/src/io/run/tests.js', '--test-name-pattern', pattern, ...extra, ...files],
    { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 240_000 });
}

test('clause 1: a name-filtered landing gate with landingShards 6 runs as six shards, each with the name filter [C7]', t => {
  const run = gate(project(t));
  assert.equal(run.status, 0, run.context ?? run.stdout + run.stderr);
  assert.match(run.stdout, /# landing shards: 6 /u, 'six shards, not one local pass');
  assert.equal([...run.stdout.matchAll(/^# landing selected cases (\d+)$/gmu)].reduce((sum, match) => sum + Number(match[1]), 0), 6,
    'every shard ran only its target case');
});

test('clause 2: a red in any name-filtered shard fails the gate and names the test; a filter matching nothing fails too [C7]', t => {
  const red = gate(project(t, 'd'));
  assert.notEqual(red.status, 0);
  assert.match(red.stdout + red.stderr, /target d/u, 'the failing case is named');
  assert.match(red.stdout, /# landing result: red/u);
  const none = gate(project(t), '^no such case$');
  assert.notEqual(none.status, 0);
  assert.match(none.stdout + none.stderr, /NO_TESTS_MATCHED/u);
});

test('clause 1: duplicate paths run once, and every selector option reaches every shard [C7]', async t => {
  const box = project(t);
  const files = [...NAMES.map(name => `test/${name}.test.js`), 'test/a.test.js', './test/b.test.js'];
  const run = gate(box, '^target', ['--test-skip-pattern', 'target [ce] '], files);
  assert.equal(run.status, 0, run.context ?? run.stdout + run.stderr);
  const cases = [...run.stdout.matchAll(/^# landing selected cases (\d+)$/gmu)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(cases, 4, 'each target runs once despite duplicate paths, and the skip pattern drops c and e in their shards');
  const { landingShardOptions } = await import('../../../../gate/index.js');
  assert.deepEqual(landingShardOptions(['--test-name-pattern', 'x', 'test/a.test.js', '--test-skip-pattern=y', '--test-timeout', '5', '--test-reporter=tap', '--', 'test/b.test.js'],
    arg => ['--test-name-pattern', '--test-timeout'].includes(arg)),
  ['--test-name-pattern', 'x', '--test-skip-pattern=y', '--test-timeout', '5', '--test-reporter=tap'], 'every option as written; only files drop');
});

test('clause 1: equivalent spellings of one test file plan onto one shard once [C7]', async () => {
  const { planLandingShards } = await import('../../../index.js');
  const root = '/repo';
  const spellings = ['test/a.test.js', './test/a.test.js', 'test/../test/a.test.js', 'test//a.test.js', 'test/./a.test.js', '/repo/test/a.test.js', 'test/b.test.js', 'test/x/../b.test.js'];
  const plan = planLandingShards(spellings, 6, { 'test/a.test.js': 900 }, root);
  assert.deepEqual(plan.map(shard => shard.files), [['test/a.test.js'], ['test/b.test.js']], 'each file is planned once, under its first spelling');
  assert.equal(plan[0].weight, 900, 'the recorded time follows the file through any spelling');
  assert.equal(planLandingShards(['test/../test/a.test.js', 'test/a.test.js'], 2).flatMap(shard => shard.files).length, 1, 'no root still folds relative spellings');
});

test('clause 1: the fan-out expands globs and folds spellings into one file list [C7]', async t => {
  const { landingFanOutFiles, optionTakesValue } = await import('../../../../gate/index.js');
  const box = project(t);
  assert.deepEqual(landingFanOutFiles(['test/a.test.js', './test/a.test.js', 'test/b.test.js'], ['--test-name-pattern', 'x'], box.repo, optionTakesValue),
    ['test/a.test.js', 'test/b.test.js'], 'each file once');
  assert.deepEqual(landingFanOutFiles(['test/[a-c].test.js', 'test/*.test.js', `${box.repo}/test/f.test.js`], [], box.repo, optionTakesValue),
    NAMES.map(name => `test/${name}.test.js`), 'globs expand to files, overlaps and absolute spellings fold');
  assert.deepEqual(landingFanOutFiles(['test/a.test.js'], ['--test-name-pattern', '--test-shard=2/2'], box.repo, optionTakesValue), ['test/a.test.js'],
    'a pattern value that looks like a shard flag is a pattern');
  const run = gate(box, '^target', [], ['test/*.test.js', 'test/[a-c].test.js']);
  assert.equal(run.status, 0, run.context ?? run.stdout + run.stderr);
  const cases = [...run.stdout.matchAll(/^# landing selected cases (\d+)$/gmu)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(cases, 6, 'overlapping globs run each of the six target cases once');
});

test('clause 1: a name-filtered landing that also carries a caller shard flag refuses USAGE and never fans out [C7]', async t => {
  const { landingFanOutFiles, optionTakesValue } = await import('../../../../gate/index.js');
  const box = project(t);
  for (const args of [['--test-shard=1/2'], ['--test-shard', '2/2'], ['--test-shard'], ['--test-name-pattern', 'x', '--test-shard'], ['--shard=1/2']]) {
    assert.throws(() => landingFanOutFiles(['test/a.test.js'], args, box.repo, optionTakesValue), error => error.code === 'USAGE', JSON.stringify(args));
  }
  for (const extra of [['--shard', '1/2'], ['--test-shard']]) {
    const run = gate(box, '^target', extra);
    assert.notEqual(run.status, 0, JSON.stringify(extra));
    assert.match(run.stdout + run.stderr, /USAGE/u);
    assert.doesNotMatch(run.stdout, /# landing selected cases/u, 'no shard ran');
  }
});

test('clause 1: a selector option missing its value refuses as the unsharded run does, and never fans out [C7]', t => {
  const box = project(t);
  for (const option of ['--test-skip-pattern', '--test-name-pattern']) {
    const run = gate(box, '^target', [], [...NAMES.map(name => `test/${name}.test.js`), option]);
    assert.notEqual(run.status, 0, option);
    assert.match(run.stdout + run.stderr, new RegExp(`${option} requires a value`, 'u'));
    assert.doesNotMatch(run.stdout, /# landing selected cases/u, 'no shard ran');
  }
});

test('clause 2: a caller --test-timeout reaches every shard, so a case that times out unsharded fails the sharded gate [C7]', t => {
  for (const extra of [['--test-timeout', '3000'], ['--test-timeout=3000']]) {
    const run = gate(project(t, null, 'd'), '^target', extra);
    assert.notEqual(run.status, 0, `${extra.join(' ')}: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /# landing shards: 6 /u, 'the run was sharded');
    assert.match(run.stdout + run.stderr, /target d|d\.test\.js/u, 'the timed-out test is named');
    assert.match(run.stdout + run.stderr, /timed out after 3000ms/u, 'the caller timeout applied');
    assert.match(run.stdout, /# landing result: red/u);
  }
});

test('clause 1: a name filter with no file arguments fans out, and its collection never claims the full suite [C7]', t => {
  const box = project(t);
  // Only the six fixture files stay tracked tests, so the unfiltered default suite is exactly them.
  const packaged = execFileSync('git', ['ls-files', '*.test.js'], { cwd: box.repo, env: box.env, encoding: 'utf8' }).split('\n').filter(file => file && !file.startsWith('test/'));
  if (packaged.length) execFileSync('git', ['rm', '-q', '--', ...packaged], { cwd: box.repo, env: box.env });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'test: only the fixture tests'], { cwd: box.repo, env: box.env });
  const run = gate({ ...box, env: { ...box.env, PULLBOARD_LANDING_COLLECT_ALL: '1', PULLBOARD_LANDING_COLLECTION_ID: 'filtered-suite' } }, '^target', [], []);
  assert.equal(run.status, 0, run.context ?? run.stdout + run.stderr);
  assert.match(run.stdout, /# landing shards: \d+ /u, 'the run was sharded');
  const suite = [...run.stdout.matchAll(/^# pullboard-landing-collection (\{.*\})$/gmu)].map(match => JSON.parse(match[1])).find(frame => frame.scope === 'suite');
  assert.ok(suite, 'the suite collection frame printed');
  assert.equal(suite.full, false, 'a filtered run is never a full-suite collection');
});

test('clause 1: files after -- stay files in every shard, under the caller spelling, even one named like an option [C7]', async t => {
  const box = project(t);
  writeFileSync(join(box.repo, '-case.test.js'), "import { test } from 'node:test';\ntest('target dash [C7]', () => {});\n");
  execFileSync('git', ['add', '--', '-case.test.js'], { cwd: box.repo, env: box.env });
  execFileSync('git', ['commit', '-q', '-m', 'test: a file named like an option'], { cwd: box.repo, env: box.env });
  const run = gate(box, '^target', [], ['./test/a.test.js', 'test/b.test.js', '--', '-case.test.js']);
  assert.equal(run.status, 0, run.context ?? run.stdout + run.stderr);
  assert.match(run.stdout, /# landing shards: 3 /u, 'three files, three shards');
  assert.equal([...run.stdout.matchAll(/^# landing selected cases (\d+)$/gmu)].reduce((sum, match) => sum + Number(match[1]), 0), 3,
    'the dash-named file ran as a test file, not an option');
  const { landingFanOutFiles, optionTakesValue } = await import('../../../../gate/index.js');
  assert.deepEqual(landingFanOutFiles(['./test/a.test.js', 'test/a.test.js', '-case.test.js', `${box.repo}/test/b.test.js`], [], box.repo, optionTakesValue),
    ['./test/a.test.js', '-case.test.js', 'test/b.test.js'], 'the first spelling is kept; only an absolute one becomes repository-relative');
});
