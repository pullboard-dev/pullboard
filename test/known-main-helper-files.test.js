/** A failing case defined in a helper module is known-main by the helper or the test file that runs it, and a nested copy counts once [V4,B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureSignatures } from '../src/main-failure-matches.js';
import { matchingMainFailures } from '../src/main-failure-matches.js';
import { ownersOf } from '../src/known-main-reworks.js';
import { fixture } from './known-main-affected.fixture.js';
import { cli } from './known-main-affected.fixture.js';

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

for (const owned of ['test/helper-cases.js', 'test/affected.test.js']) {
  test(`a helper-defined case failing identically on main is accepted when the owner names ${owned} [V4,B3]`, t => {
    const box = fixture(t, { affected: RUNNER, extra: { 'test/helper-cases.js': HELPER } });
    const owner = fileMainRed(box, owned);
    const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const known = JSON.parse(result.stdout).gate.knownMainReworks;
    assert.ok(known, JSON.stringify(JSON.parse(result.stdout).gate.report).slice(0, 1500));
    assert.deepEqual(known.map(row => [row.name, row.item]), [['helper case [G1]', owner]], 'one failure, owned once');
  });
}

/** TAP for one failed case reported twice: once nested from a run outside this root, once at the top. */
const TAP = `TAP version 13
    not ok 1 - dup case
      ---
      location: '/tmp/elsewhere/repo/test/a.test.js:3:1'
      failureType: 'testCodeFailure'
      error: 'boom'
      ...
not ok 1 - dup case
  ---
  location: '/repo/test/a.test.js:3:1'
  failureType: 'testCodeFailure'
  error: 'boom'
  ...
1..1
# tests 2
# fail 2
`;

test('a nested copy of a case with no file in this root is the same case, counted once [V4,B3]', () => {
  const failures = failureSignatures({ isGreen: false, executionRoot: '/repo', stages: [{ status: 1, output: TAP }] }, '/repo');
  assert.equal(failures?.length, 1, 'one named failure, not two and not a refusal');
  assert.deepEqual([failures[0].file, failures[0].name], ['test/a.test.js', 'dup case']);
});

test('a failure whose file is a helper matches main under the test file that ran it, and either file owns it [V4,B3]', () => {
  const signature = 'a'.repeat(64);
  const failure = { file: 'test/helper-cases.js', name: 'helper case [G1]', signature };
  const comparison = { main: 'm', files: [{ file: 'test/affected.test.js', result: 'red', failures: [{ ...failure, ran: 'test/affected.test.js' }] }] };
  const matched = matchingMainFailures([failure], comparison, 'm');
  assert.equal(matched?.failures[0].ran, 'test/affected.test.js');
  const repair = file => ({ item_id: 7, item_status: 'open', item_title: 'Main red: helper', item_check: `node test/runner.js ${file}`, item_criterion: '' });
  for (const file of ['test/helper-cases.js', 'test/affected.test.js']) assert.deepEqual(ownersOf(matched.failures[0], [repair(file)]).map(item => item.item_id), [7], file);
  assert.deepEqual(ownersOf(matched.failures[0], [repair('test/other.test.js')]), []);
  assert.equal(matchingMainFailures([{ ...failure, signature: 'b'.repeat(64) }], comparison, 'm'), null, 'a different failure on main is still refused');
});
