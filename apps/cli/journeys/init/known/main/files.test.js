/** A failing case defined in a helper module is known-main by the helper or the test file that runs it, and a nested copy counts once [V4,B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureSignatures } from '../../../../../../packages/landing/index.js';
import { matchingMainFailures } from '../../../../../../packages/landing/index.js';
import { ownersOf } from '../../../../../../packages/store/index.js';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';

const HELPER = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n"
  + "test('helper case [G1]', () => assert.equal(1, 2));\n";
const RUNNER = "import './helper-cases.js';\n";

/** File an open repair whose check names `file`, the way a real Main red is filed. */
function fileMainRed(box, file) {
  const result = cli(box, box.root, 'add', 'core', 'Main red: helper case', '--specs', 'G1',
    '--criterion', "The case 'helper case' passes on main.", '--check', `node test/runner.js ${file}`, '--brief', `Files: ${file}\nTest: helper case`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

{
  const owned = 'test/helper-cases.js';
  test(`a helper-defined case failing identically on main is accepted when the owner names ${owned} [V4,B3]`, t => {
    const box = fixture(t, { affected: RUNNER, extra: { 'test/helper-cases.js': HELPER } });
    const owner = fileMainRed(box, owned);
    const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const known = JSON.parse(result.stdout).gate.knownMainReworks;
    assert.deepEqual(known.map(row => [row.name, row.item]), [['helper case [G1]', owner]], 'one failure, owned once');
  });
}

/** Two distinct failures that share a file and a title: only their errors differ. */
const TWINS = `TAP version 13
not ok 1 - twin case
  ---
  location: '/repo/test/a.test.js:3:1'
  failureType: 'testCodeFailure'
  error: 'first error'
  ...
not ok 2 - twin case
  ---
  location: '/repo/test/a.test.js:9:1'
  failureType: 'testCodeFailure'
  error: 'second error'
  ...
1..2
# tests 2
# fail 2
`;

test('two distinct failures with one file and title stay two, and main failing only one never masks the other [V4,B3]', () => {
  const failures = failureSignatures({ isGreen: false, executionRoot: '/repo', stages: [{ status: 1, output: TWINS }] }, '/repo');
  assert.equal(failures?.length, 2, 'both failures are kept, not collapsed by file and title');
  assert.notEqual(failures[0].signature, failures[1].signature);
  const comparison = { main: 'm', files: [{ file: 'test/a.test.js', result: 'red', failures: [failures[0]] }] };
  assert.equal(matchingMainFailures([failures[0]], comparison, 'm')?.failures.length, 1, 'the failure main has is known');
  assert.equal(matchingMainFailures(failures, comparison, 'm'), null, 'the candidate-only twin is not masked by main\'s');
  assert.equal(matchingMainFailures([failures[1]], comparison, 'm'), null);
});

test('a failure whose file is a helper matches main under the test file that ran it [V4,B3]', () => {
  const signature = 'a'.repeat(64);
  const failure = { file: 'test/helper-cases.js', name: 'helper case [G1]', signature };
  const comparison = { main: 'm', files: [{ file: 'test/affected.test.js', result: 'red', failures: [{ ...failure, ran: 'test/affected.test.js' }] }] };
  assert.deepEqual(matchingMainFailures([failure], comparison, 'm'), { main: 'm', failures: [failure] }, 'the failure keeps its helper file');
  assert.equal(matchingMainFailures([{ ...failure, signature: 'b'.repeat(64) }], comparison, 'm'), null, 'a different failure on main is still refused');
  assert.equal(matchingMainFailures([{ ...failure, name: 'other [G1]' }], comparison, 'm'), null, 'a case main does not fail is still refused');
});

/** The real shape from run 864e4c0d: a helper case whose error text embeds a nested run's TAP, nested not ok line included. */
const EMBEDDED = `TAP version 13
not ok 1 - helper merge case
  ---
  duration_ms: 9
  location: '/repo/test/helper-cases.js:90:3'
  failureType: 'testCodeFailure'
  error: |-
    node --test test/a.test.js
    ok 1 - nested passing case
    not ok 2 - nested failing case
      ---
      location: '/tmp/elsewhere/repo/test/a.test.js:87:1'
      ...
  ...
1..1
# tests 1
# fail 1
`;

test('a nested run\'s TAP printed inside a failure\'s error is part of that failure, not extra failures [V4,B3]', () => {
  const failures = failureSignatures({ isGreen: false, executionRoot: '/repo', stages: [{ status: 1, output: EMBEDDED }] }, '/repo');
  assert.equal(failures?.length, 1, 'one named failure, not a refusal for lack of a complete account');
  assert.deepEqual([failures[0].file, failures[0].name], ['test/helper-cases.js', 'helper merge case']);
});
