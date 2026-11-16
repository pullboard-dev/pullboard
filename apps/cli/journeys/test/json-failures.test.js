/** @pullboard-test-input apps/cli/src/io/test/pull.js packages/gate/index.js packages/gate/tests/fixtures/child.js */
/** A pulled run whose output tail shows one failure still lists every failing file in failures[], matching the summary count [C7,#8949]. */
/** @pullboard-world-pin: the pulled-run summary reads the shipped outcome rows the runner returns. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  after,
  test,
} from 'node:test';
import { retainTestOutput } from '../../../../packages/gate/index.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import {
  failingOutcomes,
  withOutcomeFailures,
} from '../../src/io/test/pull.js';

const { root } = privateFixtureFiles('json-failures-');
after(() => rmSync(root, { recursive: true, force: true }));

const FILES = ['a', 'b', 'c', 'd'].map(name => `x/${name}.test.js`);
const outcomes = FILES.map(file => ({ file, name: `case in ${file}`, passed: false, skipped: false }));
// The runner keeps only the end of a long output: the tail shows the last failure and the totals.
const tail = ['not ok 4 - case in x/d.test.js', '  ---', '  error: boom', '  ...', '1..4', '# pass 6', '# fail 4', ''].join('\n');

/** What the pulled run records for this tail and these outcome rows. */
function recorded() {
  const ran = { output: tail, outcomes, failures: null };
  const summary = retainTestOutput(root, ran.output, { directory: root, profile: { testOutcomes: failingOutcomes(ran) } });
  return { summary, failures: withOutcomeFailures(summary.failures, ran) };
}

test('clause 1: a --json run over several files where more than one fails lists every failing file in failures[] [C7]', () => {
  const { summary, failures } = recorded();
  assert.equal(summary.failures.length, 1, 'the tail alone names one failure');
  assert.deepEqual(failures.map(row => row.file).sort(), FILES);
  assert.equal(new Set(failures.map(row => `${row.file}\0${row.name}`)).size, failures.length, 'no failure is listed twice');
});

test('clause 2: failures[] count equals the failed count in the run summary [C7]', () => {
  const { summary, failures } = recorded();
  assert.equal(failures.length, summary.counts.failed);
});
