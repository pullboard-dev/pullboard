/** A red gate reads main's recorded results at the exact main commit and reruns only files main has none for [C7]. */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { cacheFile } from '../../../../../packages/landing/index.js';
import { MAIN_FAILURE_SIGNATURE_VERSION } from '../../../../../packages/landing/index.js';
import { recordedMainComparison } from '../../../src/io/submit/recorded.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';

/** A real git repo with a test command and two test files at one main commit, and main's recorded red for `known`. */
function project(t, known) {
  const root = privateFixtureFiles('recorded-main-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(key)) delete env[key];
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  const put = (path, body) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
  runFixtureGit(['-C', root, 'init', '--quiet', '-b', 'main'], { env });
  put('pullboard.json', JSON.stringify({ affectedTests: 'node --test' }) + '\n');
  put('web/known.test.js', "import { test } from 'node:test';\ntest('main case', () => { throw new Error('main'); });\n");
  put('web/fresh.test.js', "import { test } from 'node:test';\ntest('new case', () => { throw new Error('new'); });\n");
  git('add', '-A');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture');
  const main = git('rev-parse', 'HEAD');
  mkdirSync(dirname(cacheFile(root)), { recursive: true });
  writeFileSync(cacheFile(root), JSON.stringify({ version: 2, entries: { [main]: { [known]: { result: 'red', signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION,
    failures: [{ file: known, name: 'main case', signature: 'a'.repeat(64) }], receiptId: 'mr-known' } } } }), { mode: 0o600 });
  return { root, main };
}

/** A stand-in main runner that records which files it was asked to run and reports each green. */
function runner() {
  const asked = [];
  const compare = async (root, profile, onWait, output, options) => {
    const files = profile.tests.filter(row => row.passed === false).map(row => row.file);
    asked.push(files);
    return { main: options.commit, files: files.map(file => ({ file, result: 'green', failures: [] })) };
  };
  return { asked, compare };
}

test('clause 1: a red file with a recorded red result at the current main is a main red without running on main [C7]', async t => {
  const { root, main } = project(t, 'web/known.test.js');
  const { asked, compare } = runner();
  const retained = [];
  const result = await recordedMainComparison(root, { tests: [{ file: 'web/known.test.js', passed: false }] }, undefined, '',
    { commit: main, detailed: true, onMeasuredReceipt: async id => { retained.push(id); }, execution: { executor: { kind: 'local' }, environment: {} } }, { compare });
  assert.deepEqual(asked, [], 'nothing ran on main');
  assert.equal(result.main, main);
  assert.deepEqual(result.recorded, ['web/known.test.js']);
  assert.deepEqual(result.files.map(row => [row.file, row.result, row.failures.map(failure => failure.name), row.receiptId]),
    [['web/known.test.js', 'red', ['main case'], 'mr-known']]);
  assert.deepEqual(retained, ['mr-known'], 'the recorded receipt is retained as the comparison evidence');
});

test('clause 2: a red file with no recorded main result at the current main still reruns on main, and only that file [C7]', async t => {
  const { root, main } = project(t, 'web/known.test.js');
  const { asked, compare } = runner();
  const profile = { tests: [{ file: 'web/known.test.js', passed: false }, { file: 'web/fresh.test.js', passed: false }] };
  const result = await recordedMainComparison(root, profile, undefined, '', { commit: main, detailed: true }, { compare });
  assert.deepEqual(asked, [['web/fresh.test.js']], 'only the file with no recorded result ran on main');
  assert.deepEqual(result.files.map(row => [row.file, row.result]).sort(), [['web/fresh.test.js', 'green'], ['web/known.test.js', 'red']]);

  // A recorded result at another main commit is not this main's: the file reruns.
  const other = runner();
  await recordedMainComparison(root, { tests: [{ file: 'web/known.test.js', passed: false }] }, undefined, '', { commit: 'f'.repeat(40), detailed: true }, { compare: other.compare });
  assert.equal(other.asked.length, 1, 'a file with no recorded result at that main commit ran on main');
});
