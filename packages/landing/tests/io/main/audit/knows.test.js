/** @pullboard-test-input source-tree */
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
import { runFixtureGit } from '../../../../../../apps/cli/tests/fixtures/child.js';

const RUN_TESTS = join(import.meta.dirname, '../../../../../../apps/cli/src/io/run/tests.js');

/** Write one fixture source file. */
function put(root, file, source) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); }

/** Build a real repo on main whose focused command is the given shell command, with isolated machine settings. */
function fixture(t, affectedTests) {
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
  put(directory, 'machine/settings.json', JSON.stringify({ gateSlots: 2, browserSlots: 1, gate: { browserFreeChecks: true } }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'pullboard.json', JSON.stringify({ gate: affectedTests, affectedTests }));
  put(root, 'test/pass.test.js', "import { test } from 'node:test';\ntest('main passes [C7]', () => {});\n");
  put(root, 'test/refuse.js', "process.stdout.write('TAP version 13\\n');\nprocess.stderr.write('refused before any test\\n');\nprocess.exitCode = 1;\n");
  runFixtureGit(['add', '-A'], { cwd: root, env });
  runFixtureGit(['commit', '-qm', 'test: fixture main'], { cwd: root, env });
  const main = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env }).trim();
  return { root, main, cache: join(root, '.git/pullboard/main-red.json') };
}

/** Compare one file against the fixture's main without the per-case detail landing asks for. */
function compare(box, file) {
  return compareMainFailures(box.root, { tests: [{ file, passed: false }] }, undefined, '', { commit: box.main });
}

test('apps/cli/src/io/run/tests.js runs a green main file in the comparison checkout instead of refusing on accepted main [C7]', { timeout: 120000 }, async t => {
  const box = fixture(t, `node '${RUN_TESTS}'`);
  const result = await compare(box, 'test/pass.test.js');
  assert.equal(result.unavailable, undefined, result.unavailable);
  assert.deepEqual(result.files, [{ file: 'test/pass.test.js', result: 'green' }]);
});

test('a red comparison that names no failing test or crashed file is unavailable and is never cached [C7]', { timeout: 120000 }, async t => {
  const box = fixture(t, 'node test/refuse.js');
  const result = await compare(box, 'test/pass.test.js');
  assert.match(result.unavailable ?? '', /named no failing test or crashed file/u);
  assert.deepEqual(result.files, []);
  let cached = {};
  try { cached = JSON.parse(readFileSync(box.cache, 'utf8')).entries?.[box.main] ?? {}; } catch { /* No cache file means nothing was cached. */ }
  assert.equal(cached['test/pass.test.js'], undefined, 'the run that tested nothing left no cached result');
});

test('a result cached before this fix is not reused; the file is measured again [C7]', { timeout: 120000 }, async t => {
  const box = fixture(t, `node '${RUN_TESTS}'`);
  mkdirSync(dirname(box.cache), { recursive: true });
  writeFileSync(box.cache, JSON.stringify({ version: 1, entries: { [box.main]: { 'test/pass.test.js': { result: 'red' } } } }), { mode: 0o600 });
  const result = await compare(box, 'test/pass.test.js');
  assert.deepEqual(result.files, [{ file: 'test/pass.test.js', result: 'green' }], 'the old fake red was measured again, not reused');
  const cache = JSON.parse(readFileSync(box.cache, 'utf8'));
  assert.equal(cache.version, 2);
  assert.equal(cache.entries[box.main]['test/pass.test.js'].result, 'green');
});
