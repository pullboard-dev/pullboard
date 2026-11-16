/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/** Each main test result records main's commit and time, so the first red after a green names one landing [#5809]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareMainFailures } from '../../../../index.js';
import { firstRedLanding } from '../../../../index.js';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../gate/tests/fixtures/child.js';

const RUN_TESTS = join(import.meta.dirname, '../../../../../../apps/cli/src/io/run/tests.js');
const PASS = "import { test } from 'node:test';\ntest('main passes [C7]', () => {});\n";
const FAIL = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('main passes [C7]', () => { assert.equal(1, 2); });\n";

/** Write one fixture source file. */
function put(root, file, source) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); }

/** Build a real repo on main whose focused command is Pullboard's own test runner, with isolated machine settings. */
function fixture(t) {
  const { root: directory } = privateFixtureFiles('pb-main-red-landing-');
  const root = join(directory, 'repo'); mkdirSync(root);
  const prior = { ...process.env };
  t.after(() => {
    for (const key of ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'PULLBOARD_AGENT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
    rmSync(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, { PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    PULLBOARD_AGENT: 'main-red-landing-fixture', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  put(directory, 'machine/settings.json', JSON.stringify({ gateSlots: 2, browserSlots: 1, gate: { browserFreeChecks: true } }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const sh = (...args) => runFixtureGit(args, { cwd: root, env }).trim();
  sh('init', '-q', '-b', 'main');
  const command = `node '${RUN_TESTS}'`;
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'pullboard.json', JSON.stringify({ gate: command, affectedTests: command }));
  put(root, 'test/main.test.js', PASS);
  sh('add', '-A');
  sh('commit', '-qm', 'test: fixture main');
  return { root, sh, cache: join(root, '.git/pullboard/main-red.json') };
}

/** Compare one file against main at `commit`. */
function compare(root, commit, file) {
  return compareMainFailures(root, { tests: [{ file, passed: false }] }, undefined, '', { commit });
}

test('a main test result records the main commit and the time with each file result [C7]', { timeout: 120000 }, async t => {
  const box = fixture(t);
  const main = box.sh('rev-parse', 'HEAD');
  const before = Date.now();
  const result = await compare(box.root, main, 'test/main.test.js');
  assert.equal(result.unavailable, undefined, result.unavailable);
  const row = JSON.parse(readFileSync(box.cache, 'utf8')).entries[main]['test/main.test.js'];
  assert.equal(row.result, 'green');
  assert.equal(row.main, main, 'the result names the main commit it measured');
  assert.ok(Date.parse(row.at) >= before - 1000 && Date.parse(row.at) <= Date.now() + 1000, `the result carries its time, got ${row.at}`);
});

test('a green then a red for one file on consecutive main commits names the single landing between them [C7]', { timeout: 180000 }, async t => {
  const box = fixture(t);
  const green = box.sh('rev-parse', 'HEAD');
  box.sh('checkout', '-qb', 'item-42');
  put(box.root, 'test/main.test.js', FAIL);
  box.sh('commit', '-qam', 'feat(core): break the test [C7]');
  box.sh('checkout', '-q', 'main');
  box.sh('merge', '-q', '--no-ff', '-m', 'Merge #42 onto main [C7]', 'item-42');
  const red = box.sh('rev-parse', 'HEAD');
  const after = await compare(box.root, red, 'test/main.test.js');
  assert.deepEqual(after.files.map(row => row.result), ['red'], after.unavailable);
  assert.equal(firstRedLanding(box.root, 'test/main.test.js'), null, 'a red with no recorded green before it names no landing');
  const before = await compare(box.root, green, 'test/main.test.js');
  assert.deepEqual(before.files.map(row => row.result), ['green'], before.unavailable);
  const found = firstRedLanding(box.root, 'test/main.test.js');
  assert.equal(found?.landing, red, 'the landing is the red main commit');
  assert.equal(found.item, 42, 'the landing names its item');
  assert.equal(found.green.main, green);
  assert.equal(found.red.main, red);
  assert.ok(found.green.at && found.red.at, 'both results carry their time');
});
