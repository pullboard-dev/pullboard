/** @pullboard-test-input source-cell api */
/** compareGateWithMain counts a timing red as main's when excuseTiming is on, and only then (#9755) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareGateWithMain } from '../../../index.js';
import { provideTimingExcuse } from '../../../index.js';

const MAIN = 'a'.repeat(40);
const FILE = 'apps/cli/tests/io/commands/read-startup.test.js';

/** A red receipt failing one case, with no diagnostic signature, as one whose message carries measured milliseconds reads. */
function redReceipt(file, name) {
  return { gate: { phases: [{ role: 'proof', status: 1, failures: [{ file, name }] }] } };
}

/** A main-receipt lookup answering that main has no record of owning the case: main fails it under its own name. */
const lookup = ({ cases }) => ({ classes: cases.map(({ file }) => ({ file, owner: 'main', own: [], receipt: null, job: null })) });

/** The onMain verdict of the one case, through compareGateWithMain with the given options. */
function verdict(file, name, options) {
  const compared = compareGateWithMain({ gitRoot: '/repo', db: null }, redReceipt(file, name), MAIN, lookup, options);
  assert.equal(compared.cases.length, 1);
  return compared.cases[0].onMain;
}

test('clause 1: with excuseTiming off a read-startup case whose signature differs from main\'s reads onMain false (#9755) [C7]', () => {
  assert.equal(verdict(FILE, 'clause 1: reports within 200 ms'), false);
  assert.equal(verdict(FILE, 'clause 1: reports within 200 ms', { excuseTiming: false }), false);
});

test('clause 2: with excuseTiming on the same case reads onMain true, and a case outside the timing table stays false (#9755) [C7]', () => {
  assert.equal(verdict(FILE, 'clause 1: reports within 200 ms', { excuseTiming: true }), true);
  assert.equal(verdict(FILE, 'clause 2: some other case', { excuseTiming: true }), false);
  assert.equal(verdict('apps/cli/tests/io/commands/other.test.js', 'clause 1: reports within 200 ms', { excuseTiming: true }), false);
});

test('clause 2: a host\'s provideTimingExcuse answer turns the excuse on for every comparison until it is removed (#9755) [C7]', () => {
  try {
    provideTimingExcuse(() => true);
    assert.equal(verdict(FILE, 'clause 1: reports within 200 ms'), true);
    provideTimingExcuse(() => false);
    assert.equal(verdict(FILE, 'clause 1: reports within 200 ms'), false);
  } finally { provideTimingExcuse(null); }
  assert.equal(verdict(FILE, 'clause 1: reports within 200 ms'), false);
});
