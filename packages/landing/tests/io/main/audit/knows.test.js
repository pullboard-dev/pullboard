/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/** A main comparison runs its tests in a checkout that knows it is main, and a run that tested nothing is never a red [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareMainFailures } from '../../../../index.js';
import { matchingMainFailures } from '../../../../index.js';
import { runFixtureGit } from '../../../../../gate/tests/fixtures/child.js';

const RUN_TESTS = join(import.meta.dirname, '../../../../../../apps/cli/src/io/run/tests.js');

/** Write one fixture source file. */
function put(root, file, source) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); }

/** Build a real repo on main whose focused command is the given shell command, with isolated machine settings. */
function fixture(t, affectedTests, { files = {}, gate = {} } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pb-knows-main-')));
  const root = join(directory, 'repo'); mkdirSync(root);
  const prior = { ...process.env };
  t.after(() => {
    for (const key of ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'PULLBOARD_AGENT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
    rmSync(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, { PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    PULLBOARD_AGENT: 'knows-main-fixture', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  put(directory, 'machine/settings.json', JSON.stringify({ gateSlots: 2, browserSlots: 1, gate: { browserFreeChecks: true, ...gate } }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'pullboard.json', JSON.stringify({ gate: affectedTests, affectedTests }));
  put(root, 'test/pass.test.js', "import { test } from 'node:test';\ntest('main passes [C7]', () => {});\n");
  put(root, 'test/refuse.js', "process.stdout.write('TAP version 13\\n');\nprocess.stderr.write('refused before any test\\n');\nprocess.exitCode = 1;\n");
  for (const [file, source] of Object.entries(files)) put(root, file, source);
  runFixtureGit(['add', '-A'], { cwd: root, env });
  runFixtureGit(['commit', '-qm', 'test: fixture main'], { cwd: root, env });
  const main = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env }).trim();
  return { root, main, cache: join(root, '.git/pullboard/main-red.json') };
}

/** Compare one file against the fixture's main without the per-case detail landing asks for. */
function compare(box, file) {
  return compareMainFailures(box.root, { tests: [{ file, passed: false }] }, undefined, '', { commit: box.main });
}

test('landing.knows.apps-cli-src-io-run-tests: apps/cli/src/io/run/tests.js runs a green main file in the comparison checkout instead of refusing on accepted main [C7]', { timeout: 120000 }, async t => {
  const box = fixture(t, `node '${RUN_TESTS}'`);
  const result = await compare(box, 'test/pass.test.js');
  assert.equal(result.unavailable, undefined, result.unavailable);
  assert.deepEqual(result.files, [{ file: 'test/pass.test.js', result: 'green' }]);
});

test('landing.knows.a-red-comparison-that-names-no: a red comparison that names no failing test or crashed file is unavailable and is never cached [C7]', { timeout: 120000 }, async t => {
  const box = fixture(t, 'node test/refuse.js');
  const result = await compare(box, 'test/pass.test.js');
  assert.match(result.unavailable ?? '', /named no failing test or crashed file/u);
  assert.deepEqual(result.files, []);
  let cached = {};
  try { cached = JSON.parse(readFileSync(box.cache, 'utf8')).entries?.[box.main] ?? {}; } catch { /* No cache file means nothing was cached. */ }
  assert.equal(cached['test/pass.test.js'], undefined, 'the run that tested nothing left no cached result');
});

test('landing.knows.a-result-cached-before-this-fix: a result cached before this fix is not reused; the file is measured again [C7]', { timeout: 120000 }, async t => {
  const box = fixture(t, `node '${RUN_TESTS}'`);
  mkdirSync(dirname(box.cache), { recursive: true });
  writeFileSync(box.cache, JSON.stringify({ version: 1, entries: { [box.main]: { 'test/pass.test.js': { result: 'red' } } } }), { mode: 0o600 });
  const result = await compare(box, 'test/pass.test.js');
  assert.deepEqual(result.files, [{ file: 'test/pass.test.js', result: 'green' }], 'the old fake red was measured again, not reused');
  const cache = JSON.parse(readFileSync(box.cache, 'utf8'));
  assert.equal(cache.version, 2);
  assert.equal(cache.entries[box.main]['test/pass.test.js'].result, 'green');
});

const THREE_CASES = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n"
  + "test('red on main', () => assert.equal(1, 2));\ntest('green on main', () => {});\ntest('unnamed red', () => assert.equal(1, 2));\n";
const FILTER_RUNNER = "import { spawnSync } from 'node:child_process';\nconst r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...process.argv.slice(2)], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });\nprocess.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exitCode = r.status ?? 1;\n";

/** A fixture whose main holds a three-case file and a runner that forwards the case filter, with gate.mainCaseFilter set as given. */
function filterBox(t, on) {
  return fixture(t, 'env -u NODE_TEST_CONTEXT node test/runner.js', { files: { 'test/three.test.js': THREE_CASES, 'test/runner.js': FILTER_RUNNER }, gate: on ? { mainCaseFilter: true } : {} });
}

/** The candidate's profile: the file with the named cases failed. */
const failedCases = (...names) => ({ tests: names.map(name => ({ file: 'test/three.test.js', name, passed: false })) });

test('landing.knows.the-comparison-runs-only-the-failing: clause 1: the comparison runs only the failing case names on base main, a case main fails by that name is known-main and one it passes is own [C7,#8761]', { timeout: 120000 }, async t => {
  const box = filterBox(t, true);
  const result = await compareMainFailures(box.root, failedCases('red on main', 'green on main'), undefined, '', { commit: box.main, detailed: true });
  assert.equal(result.unavailable, undefined, result.unavailable);
  const row = result.files.find(entry => entry.file === 'test/three.test.js');
  assert.equal(row.result, 'red');
  assert.deepEqual(row.failures.map(failure => failure.name), ['red on main'], 'the unnamed red case did not run on base main');
  assert.ok(matchingMainFailures([row.failures[0]], result, box.main), 'a case main fails by the same name is known-main');
  const own = { file: 'test/three.test.js', name: 'green on main', signature: 'c'.repeat(64) };
  assert.equal(matchingMainFailures([own], result, box.main), null, 'a case main passes stays the candidate\'s own');
  let cached = {};
  try { cached = JSON.parse(readFileSync(box.cache, 'utf8')).entries?.[box.main] ?? {}; } catch { /* No cache file means nothing was cached. */ }
  assert.equal(cached['test/three.test.js'], undefined, 'a filtered result never stands in for the whole file');
});

test('landing.knows.a-filtered-base-run-that-names: clause 2: a filtered base run that names no case is unavailable and never green [C7,#8761]', { timeout: 120000 }, async t => {
  const box = filterBox(t, true);
  const result = await compareMainFailures(box.root, failedCases('no such case'), undefined, '', { commit: box.main, detailed: true });
  assert.match(result.unavailable ?? '', /ran none of the named cases/u);
  assert.deepEqual(result.files, []);
});

test('landing.knows.with-gate-maincasefilter-off-the-whole: clause 1: with gate.mainCaseFilter off the whole file runs on base main as before [C7,#8761]', { timeout: 120000 }, async t => {
  const box = filterBox(t, false);
  const result = await compareMainFailures(box.root, failedCases('red on main'), undefined, '', { commit: box.main, detailed: true });
  const row = result.files.find(entry => entry.file === 'test/three.test.js');
  assert.deepEqual(row.failures.map(failure => failure.name).sort(), ['red on main', 'unnamed red']);
});
