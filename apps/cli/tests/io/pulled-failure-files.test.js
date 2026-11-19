/** @pullboard-test-input apps/cli/src/io/test/pull.js packages/gate/index.js packages/drive/index.js packages/gate/tests/fixtures/child.js */
/** A red pulled run records each failing case with the file its outcome line names, and --status prints it [C7,#8852]. */
/** @pullboard-world-pin: the pulled-run summary reads the shipped outcome frames the runner prints. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after } from 'node:test';
import { test } from 'node:test';
import { retainTestOutput } from '../../../../packages/gate/index.js';
import { TEST_OUTCOMES_PREFIX } from '../../../../packages/gate/index.js';
import { testRunLines } from '../../../../packages/drive/index.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { failingOutcomes } from '../../src/io/test/pull.js';

const { root } = privateFixtureFiles('pulled-files-');
after(() => rmSync(root, { recursive: true, force: true }));

const ID = '11111111-2222-3333-4444-555555555555';
const frame = row => `${TEST_OUTCOMES_PREFIX}${JSON.stringify({ version: 1, id: ID, tests: [row] })}\n`;
const outcome = (file, name, passed) => ({ file, name, passed, skipped: false, ...passed ? {} : { failure: 'assertion' } });
const output = [
  'TAP version 13', 'ok 1 - case in a', 'not ok 2 - case that fails in b', '  ---', '  error: boom', '  ...',
  'not ok 3 - case that fails in c', '  ---', '  error: bang', '  ...', '1..3', '# pass 1', '# fail 2', '',
].join('\n') + frame(outcome('a/a.test.js', 'case in a', true)) + frame(outcome('b/b.test.js', 'case that fails in b', false))
  + frame(outcome('c/c.test.js', 'case that fails in c', false));

/** The failures a pulled run records for the output, with the outcomes the seat could read. */
function recorded(ran) {
  return retainTestOutput(root, ran.output, { directory: root, profile: { testOutcomes: failingOutcomes(ran) } }).failures;
}

test('cli.io-pulled-failure-files.a-red-pulled-run-of-several-files: clause 1: a red pulled run of several files records each failure with the file its outcome line names, never null [C7]', () => {
  const failures = recorded({ output, outcomes: null });
  assert.deepEqual(failures.map(row => [row.file, row.name]), [['b/b.test.js', 'case that fails in b'], ['c/c.test.js', 'case that fails in c']]);
  const receipt = recorded({ output: output.split('\n').filter(line => !line.startsWith(TEST_OUTCOMES_PREFIX)).join('\n'),
    outcomes: [outcome('b/b.test.js', 'case that fails in b', false), outcome('c/c.test.js', 'case that fails in c', false)] });
  assert.deepEqual(receipt.map(row => row.file), ['b/b.test.js', 'c/c.test.js']);
});

test('cli.io-pulled-failure-files.test-status-prints-the-failing-file-beside: clause 2: test --status prints the failing file beside each failing case [C7]', () => {
  const failures = recorded({ output, outcomes: null });
  const lines = testRunLines({ id: 'run-1', status: 'red', files: ['b/b.test.js', 'c/c.test.js'], log: null, refusal: null,
    result: { runner: 'host-1', seconds: 5, failures, notices: [] } });
  assert.ok(lines.includes('  failing: b/b.test.js: case that fails in b: boom'), lines.join('\n'));
  assert.ok(lines.includes('  failing: c/c.test.js: case that fails in c: bang'), lines.join('\n'));
  assert.ok(!lines.some(line => line.includes('(file unavailable)')));
});
