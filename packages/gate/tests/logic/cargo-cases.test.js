/** @pullboard-test-input source-cell gate */
/** @pullboard-test-input packages/gate/tests/fixtures/cargo-test-output.txt */
/** @pullboard-world-pin reads the checked-in cargo test output fixture to prove the libtest reader. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cargoTestCases } from '../../src/logic/junit.js';

const OUTPUT = readFileSync(new URL('../fixtures/cargo-test-output.txt', import.meta.url), 'utf8');

test('gate.cargo-cases.libtest-lines-to-cases: clause 1: cargoTestCases reads libtest ok, FAILED and ignored lines into junitCases-shaped cases [C7]', () => {
  const { cases, reason } = cargoTestCases(OUTPUT);
  assert.equal(reason, null);
  assert.deepEqual(cases.map(({ name, outcome }) => ({ name, outcome })), [
    { name: 'a::b', outcome: 'pass' },
    { name: 'a::c', outcome: 'fail' },
    { name: 'a::d', outcome: 'skip' },
    { name: 'it::works', outcome: 'pass' },
  ]);
});

test('gate.cargo-cases.failure-carries-panic-line: clause 2: each failing case carries the first panic line of its stdout block as its message [C7]', () => {
  const { cases } = cargoTestCases(OUTPUT);
  assert.match(cases.find(found => found.name === 'a::c').message, /panicked at src\/lib\.rs:9:5:/u);
  assert.equal(cases.find(found => found.name === 'a::b').message, undefined);
});

test('gate.cargo-cases.unreadable-and-two-binaries: clause 3: output with no libtest lines gives CARGO_UNREADABLE, and two test binaries keep both binaries cases [C7]', () => {
  for (const bad of ['', 'error: could not compile', null, undefined]) assert.deepEqual(cargoTestCases(bad), { cases: [], reason: 'CARGO_UNREADABLE' });
  const { cases } = cargoTestCases(OUTPUT);
  assert.ok(cases.some(found => found.name === 'a::b') && cases.some(found => found.name === 'it::works'));
});
