/** A gate whose command is plain node --test, under whatever reporter this Node defaults to, still names its failures [C7,V4]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { landingFailures } from '../../../../index.js';
import { landingJunitLanguage } from '../../../../index.js';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../../gate/tests/fixtures/child.js';

/**
 * Run `node --test` with no reporter flag in a one-file red project and return what the landing reads.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ root: string, output: string, status: number | null }}
 */
function redProject(t) {
  const project = privateFixtureFiles('pullboard-gate-reporter-');
  t.after(() => rmSync(project.root, { recursive: true, force: true }));
  project.write('package.json', '{"type":"module"}\n');
  project.write('web/red.test.js', `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('red fixture case [C7]', () => assert.fail('intentional gate reporter failure'));
`);
  const env = { ...process.env };
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'PULLBOARD_RUNNER_PRELOAD']) delete env[key];
  const result = runFixtureChild(process.execPath, ['--test'], { cwd: project.root, env, encoding: 'utf8', timeout: 60000 });
  return { root: project.root, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`, status: result.status };
}

test('landing.reporter.a-red-project-under-plain-node: clause 1: a red project under plain node --test lands red naming its failing file and test [C7,V4]', t => {
  const { root, output, status } = redProject(t);
  assert.equal(status, 1, output);
  const failures = landingFailures(output, root);
  assert.deepEqual(failures.map(({ file, name }) => ({ file, name })),
    [{ file: 'web/red.test.js', name: 'red fixture case [C7]' }], output);
});

test('landing.reporter.the-fixture-run-loads-and-runs: clause 2: the fixture run loads and runs its failing case, so the red is not an empty run [C7,V4]', t => {
  const { output } = redProject(t);
  assert.match(output, /^(?:# |ℹ )tests 1$/mu, 'the run counted exactly the one fixture case');
  assert.match(output, /^(?:# |ℹ )fail 1$/mu, 'the run counted that case as failed');
  assert.match(output, /intentional gate reporter failure/u, 'the fixture case body actually executed');
});

test('landing.reporter.a-python-report-failure-lands-with-its-file: clause 3: a python project root gives landing the python language, so a pytest report failure lands with its file; a mixed root gives none [C7]', t => {
  const project = privateFixtureFiles('pullboard-gate-junit-lang-');
  t.after(() => rmSync(project.root, { recursive: true, force: true }));
  project.write('pytest.ini', '[pytest]\n');
  assert.equal(landingJunitLanguage(project.root), 'python');
  const xml = '<testsuites><testsuite name="pytest"><testcase classname="tests.test_math" name="halves"><failure message="assert 1 == 2">boom</failure></testcase></testsuite></testsuites>';
  const rows = landingFailures('', project.root, { junitFailures: true, junitXml: xml, junitLanguage: landingJunitLanguage(project.root) });
  assert.deepEqual(rows.map(({ file, name }) => ({ file, name })), [{ file: 'tests/test_math.py', name: 'halves' }]);
  project.write('go.mod', 'module m\n');
  assert.equal(landingJunitLanguage(project.root), null);
});
