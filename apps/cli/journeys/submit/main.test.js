/**
 * Submit passes a neighbouring red that base main fails by the same case, and keeps exact signatures for the item's own
 * cases [C7]. These drive the proof-phase main-red decision submit makes after its base-main comparison.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownCase } from '../../src/io/submit/reds.js';
import {
  proofMainFailures,
  redsAreMains,
} from '../../src/io/submit/reds.js';

const MAIN = 'a'.repeat(40);
const bar = { criterion: "1. greet names the visitor, proved by 'greets by first name' in test/greet.test.js [test].", check: 'node --test test/greet.test.js' };

/** A base-main comparison in which each listed file ran red with these cases and signatures. */
function comparison(files) {
  return { main: MAIN, files: files.map(({ file, cases }) => ({ file, result: cases.length ? 'red' : 'green',
    failures: cases.map(([name, signature, firstError]) => ({ file, name, signature, ...(firstError ? { firstError } : {}) })) })) };
}

test('clause 1: a submit whose only reds are neighbouring cases base main also fails by file and case name passes, though their run details differ [C7]', () => {
  const failures = [{ file: 'test/other.test.js', name: 'lists the board', signature: 'at /tmp/checkout-1/x.js:10 timeout 4012ms', firstError: 'expected 2 lines' }];
  const main = comparison([{ file: 'test/other.test.js', cases: [['lists the board', 'at /tmp/checkout-9/x.js:10 timeout 3990ms', 'expected 2 lines']] }]);
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

test('clause 1b: a neighbouring case with another assertion than main, or two cases sharing a title, stays red [C7,V4]', () => {
  const failure = { file: 'test/other.test.js', name: 'lists the board', signature: 'a', firstError: 'expected 2 lines' };
  const main = (firstError) => comparison([{ file: 'test/other.test.js', cases: [['lists the board', 'b', firstError]] }]);
  assert.deepEqual(proofMainFailures([failure], main('expected 2 lines'), MAIN, bar), { main: MAIN, failures: [failure] });
  assert.equal(proofMainFailures([failure], main('expected 3 lines'), MAIN, bar), null, 'the same title with another assertion is the item\'s regression');
  assert.equal(proofMainFailures([{ ...failure, firstError: undefined }], main(undefined), MAIN, bar), null, 'a case with no assertion to compare never passes by name alone');
  const twin = { ...failure, file: 'test/second.test.js' };
  const both = comparison([{ file: 'test/other.test.js', cases: [['lists the board', 'b', 'expected 2 lines']] }, { file: 'test/second.test.js', cases: [['lists the board', 'b', 'expected 2 lines']] }]);
  assert.equal(proofMainFailures([failure, twin], both, MAIN, bar), null, 'matching by title is ambiguous, so submit refuses');
});

test('clause 3: a red in a case base main passes stays red [C7]', () => {
  const failures = [{ file: 'test/other.test.js', name: 'lists the board', signature: 'x' }];
  assert.equal(proofMainFailures(failures, comparison([{ file: 'test/other.test.js', cases: [] }]), MAIN, bar), null, 'main ran the file green');
  assert.equal(proofMainFailures(failures, comparison([{ file: 'test/other.test.js', cases: [['another case', 'x']] }]), MAIN, bar), null, 'main fails a different case only');
  assert.equal(proofMainFailures(failures, { ...comparison([{ file: 'test/other.test.js', cases: [['lists the board', 'x']] }]), main: 'b'.repeat(40) }, MAIN, bar), null, 'a comparison at another main proves nothing');
});

test('clause 4: the red-loop guard ignores a red gate whose every failure main fails by the same name [C7]', () => {
  const red = [{ file: 'test/other.test.js', name: 'lists the board' }, { file: 'test/other.test.js', name: 'shows lanes' }];
  const main = comparison([{ file: 'test/other.test.js', cases: [['lists the board', 'a'], ['shows lanes', 'b']] }]);
  assert.equal(redsAreMains(red, main, MAIN), true, 'main fails both cases by name');
  assert.equal(redsAreMains([...red, { file: 'test/other.test.js', name: 'new case' }], main, MAIN), false, 'one case main passes keeps the red counted');
  assert.equal(redsAreMains([], main, MAIN), false, 'a red with no named case is never excused');
  assert.equal(redsAreMains(red, { main: MAIN, files: [] }, MAIN), false, 'a file the cache lacks proves nothing');
});
