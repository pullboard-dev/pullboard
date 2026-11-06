/**
 * Submit passes a neighbouring red that base main fails by the same case, and keeps exact signatures for the item's own
 * cases [C7]. These drive the proof-phase main-red decision submit makes after its base-main comparison.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownCase } from '../apps/cli/src/shell/submit-neighbour-reds.js';
import { proofMainFailures, redsAreMains } from '../apps/cli/src/shell/submit-neighbour-reds.js';
import '../apps/cli/index.js'; // The end-to-end case invokes the real CLI through its public executable.
import { cli, fixture, source, submittedProof } from './submit-main-red-fixture.js';

const MAIN = 'a'.repeat(40);
const bar = { criterion: "1. greet names the visitor, proved by 'greets by first name' in test/greet.test.js [test].", check: 'node --test test/greet.test.js' };

/** A base-main comparison in which each listed file ran red with these cases and signatures. */
function comparison(files) {
  return { main: MAIN, files: files.map(({ file, cases }) => ({ file, result: cases.length ? 'red' : 'green',
    failures: cases.map(([name, signature]) => ({ file, name, signature })) })) };
}

test('clause 1: a submit whose only reds are neighbouring cases base main also fails by file and case name passes, though their details differ [C7]', () => {
  const failures = [{ file: 'test/other.test.js', name: 'lists the board', signature: 'at /tmp/checkout-1/x.js:10 timeout 4012ms' }];
  const main = comparison([{ file: 'test/other.test.js', cases: [['lists the board', 'at /tmp/checkout-9/x.js:10 timeout 3990ms']] }]);
  assert.equal(ownCase(failures[0], bar), false, 'the case is outside the criterion and check');
  assert.deepEqual(proofMainFailures(failures, main, MAIN, bar), { main: MAIN, failures }, 'the red is accounted for as known main');
});

test('clause 2: a red in a case the criterion or check names still needs the exact main signature [C7]', () => {
  const own = { file: 'test/greet.test.js', name: 'greets by first name', signature: 'expected Hello, Ada got Hello' };
  const main = (signature) => comparison([{ file: 'test/greet.test.js', cases: [['greets by first name', signature]] }]);
  assert.equal(ownCase(own, bar), true, 'the check runs this file and the criterion names the case');
  assert.equal(proofMainFailures([own], main('expected Hello, Ada got undefined'), MAIN, bar), null, 'a different signature stays red');
  assert.deepEqual(proofMainFailures([own], main(own.signature), MAIN, bar), { main: MAIN, failures: [own] }, 'the exact signature still passes');
  // A neighbour beside an unmatched own case does not rescue the run.
  const neighbour = { file: 'test/other.test.js', name: 'lists the board', signature: 'x' };
  const both = comparison([{ file: 'test/greet.test.js', cases: [['greets by first name', 'different']] }, { file: 'test/other.test.js', cases: [['lists the board', 'y']] }]);
  assert.equal(proofMainFailures([own, neighbour], both, MAIN, bar), null);
});

test('clause 3: a red in a case base main passes stays red [C7]', () => {
  const failures = [{ file: 'test/other.test.js', name: 'lists the board', signature: 'x' }];
  assert.equal(proofMainFailures(failures, comparison([{ file: 'test/other.test.js', cases: [] }]), MAIN, bar), null, 'main ran the file green');
  assert.equal(proofMainFailures(failures, comparison([{ file: 'test/other.test.js', cases: [['another case', 'x']] }]), MAIN, bar), null, 'main fails a different case only');
  assert.equal(proofMainFailures(failures, { ...comparison([{ file: 'test/other.test.js', cases: [['lists the board', 'x']] }]), main: 'b'.repeat(40) }, MAIN, bar), null, 'a comparison at another main proves nothing');
});

test('clause 1: a real submit queues green when its only red is a neighbouring case main also fails by name, though its details differ [C7]', { timeout: 240_000 }, t => {
  // Main fails 'shared failure [G1]' in test/inherited.test.js with 1 !== 2. This candidate leaves the case red but with 1 !== 3,
  // so its failure details differ from main's. The item's criterion and check ('test -f change.txt') never name that file or case.
  const box = fixture(t, { candidate: source('shared failure [G1]', 3) });
  const result = cli(box, box.builder, 'submit', String(box.item));
  assert.equal(result.status, 0, `a neighbouring known-main red must not refuse the submit: ${result.stdout}${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.gate.green, false, 'the receipt keeps the real red');
  assert.equal(report.gate.knownMainFailures.main, box.main);
  assert.deepEqual(report.gate.knownMainFailures.failures.map(({ file, name }) => ({ file, name })), [{ file: 'test/inherited.test.js', name: 'shared failure [G1]' }]);
  const recorded = submittedProof(box).submissionProof.knownMainFailures;
  assert.equal(recorded.main, box.main);
  assert.deepEqual(recorded.failures.map(({ file, name }) => ({ file, name })), [{ file: 'test/inherited.test.js', name: 'shared failure [G1]' }], 'the board records that case as known main');
});

test('clause 4: the red-loop guard ignores a red gate whose every failure main fails by the same name [C7]', () => {
  const red = [{ file: 'test/other.test.js', name: 'lists the board' }, { file: 'test/other.test.js', name: 'shows lanes' }];
  const main = comparison([{ file: 'test/other.test.js', cases: [['lists the board', 'a'], ['shows lanes', 'b']] }]);
  assert.equal(redsAreMains(red, main, MAIN), true, 'main fails both cases by name');
  assert.equal(redsAreMains([...red, { file: 'test/other.test.js', name: 'new case' }], main, MAIN), false, 'one case main passes keeps the red counted');
  assert.equal(redsAreMains([], main, MAIN), false, 'a red with no named case is never excused');
  assert.equal(redsAreMains(red, { main: MAIN, files: [] }, MAIN), false, 'a file the cache lacks proves nothing');
});
