/** Landing judges a red against main case by case and file by file: one unreadable file never hides the rest [C7,#3073]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchingMainFailures } from '../../../../../src/io/main/matches.js';
import { splitBaseRed } from '../../../../../src/io/step/diagnose.js';

const MAIN = 'a'.repeat(40);
const comparison = { main: MAIN, files: [{ file: 'test/a.test.js', result: 'red', failures: [{ file: 'test/a.test.js', name: 'case x', signature: '1'.repeat(64) }] }] };

test('landing matches a case main fails by file and name, whatever its run-specific signature [C7,#3073]', () => {
  const failure = { file: 'test/a.test.js', name: 'case x', signature: '2'.repeat(64) };
  assert.ok(matchingMainFailures([failure], comparison, MAIN, { byCase: true }), 'a red case on main is known by case');
  assert.equal(matchingMainFailures([failure], comparison, MAIN), null, 'submit and verify keep the exact signature');
  assert.equal(matchingMainFailures([{ ...failure, name: 'case y' }], comparison, MAIN, { byCase: true }), null, 'a case main passes never matches');
});

test('a file main could not be compared on stays own and never hides another file\'s known cases [C7,#3073]', async () => {
  const state = { batch: { root: '/tmp/x', base: MAIN }, onWait: undefined };
  const failures = [{ file: 'test/a.test.js', name: 'case x' }, { file: 'test/b.test.js', name: 'timed out case' }];
  // The real comparator answers one combined request with nothing when any file is unavailable, so each file is asked alone.
  const compare = async (root, { tests }) => (tests[0].file === 'test/a.test.js' ? comparison : { main: MAIN, files: [], unavailable: 'timed out' });
  const split = await splitBaseRed(state, failures, compare, () => true);
  assert.deepEqual(split.known.map(row => row.name), ['case x'], 'the compared file splits case by case');
  assert.deepEqual(split.own.map(row => row.name), ['timed out case'], 'the uncompared file stays the batch\'s own');
});

test('a comparison that answers nothing at all still holds the batch [C7,#3073]', async () => {
  const state = { batch: { root: '/tmp/x', base: MAIN } };
  const split = await splitBaseRed(state, [{ file: 'test/a.test.js', name: 'case x' }], async () => ({ main: MAIN, files: [], unavailable: 'down' }), () => true);
  assert.equal(split, null);
});
