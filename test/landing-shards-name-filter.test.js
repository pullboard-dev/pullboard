/** @pullboard-test-input source-tree */
/** A name-filtered landing gate shards like any other landing gate, and a red in any shard still fails it [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../packages/runners/index.js';
import { runFixtureChild } from './fixture-child.js';

const SOURCE = resolve(import.meta.dirname, '..');
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f'];

/** A private project with six test files, each holding a target case and an unrelated one, and landingShards 6. */
function project(t, redFile = null) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-name-shards-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), home = join(dir, 'home');
  mkdirSync(join(repo, 'test'), { recursive: true });
  mkdirSync(join(home, '.pullboard'), { recursive: true });
  writeFileSync(join(home, '.pullboard', 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 1 }));
  copyPackageFiles(SOURCE, repo);
  for (const name of NAMES) {
    writeFileSync(join(repo, 'test', `${name}.test.js`), `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n`
      + `test('target ${name} [C7]', () => assert.equal(${JSON.stringify(name === redFile ? 'red' : 'green')}, 'green'));\n`
      + `test('unrelated ${name} [C7]', () => assert.fail('the name filter must skip this case'));\n`);
  }
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node bin/run-tests.js', landingShards: 6 }));
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: join(home, '.pullboard'), GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PULLBOARD_LANDING_RUN: '1' };
  for (const key of Object.keys(env)) if (/^PULLBOARD_(GATE_SLOT|BROWSER_SLOT|LANDING_SHARD)/u.test(key) || key === 'NODE_TEST_CONTEXT') delete env[key];
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'test: name-filtered shards fixture']]) execFileSync('git', args, { cwd: repo, env });
  return { repo, env };
}

/** Run the landing gate with a name filter over all six files. */
function gate(box, pattern = '^target') {
  return runFixtureChild(process.execPath, ['bin/run-tests.js', '--test-name-pattern', pattern, ...NAMES.map(name => `test/${name}.test.js`)],
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
