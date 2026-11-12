/** A main move during a landing reruns only the tests whose closure reaches both main's change and the batch's [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interactingTests } from '../../../index.js';

const closures = new Map([
  ['test/batch-only.test.js', { files: ['test/batch-only.test.js', 'src/batch.js'] }],
  ['test/trunk-only.test.js', { files: ['test/trunk-only.test.js', 'src/trunk.js'] }],
  ['test/both.test.js', { files: ['test/both.test.js', 'src/batch.js', 'src/trunk.js'] }],
  ['test/neither.test.js', { files: ['test/neither.test.js', 'src/other.js'] }],
  ['test/unreadable.test.js', { files: null }],
]);

test('clause 1: a move whose files share no test closure with the batch reruns nothing, so the batch proof stands [C7]', () => {
  const reruns = interactingTests(closures, { trunkFiles: new Set(['src/other.js']), batchFiles: new Set(['src/batch.js']), trunkAffected: { full: false, files: ['test/neither.test.js'] } });
  assert.deepEqual(reruns, []);
});

test('clause 2: only a test reaching both sides reruns; a test reaching one side keeps the proof that side already has [C7]', () => {
  const reruns = interactingTests(closures, { trunkFiles: new Set(['src/trunk.js']), batchFiles: new Set(['src/batch.js']), trunkAffected: { full: false, files: ['test/trunk-only.test.js', 'test/both.test.js'] } });
  assert.deepEqual(reruns, ['test/both.test.js']);
});

test('clause 3: a test whose closure cannot be read reruns when main\'s move names it, or when that move reaches every test [C7]', () => {
  const sides = { trunkFiles: new Set(['src/trunk.js']), batchFiles: new Set(['src/batch.js']) };
  assert.deepEqual(interactingTests(closures, { ...sides, trunkAffected: { full: false, files: ['test/unreadable.test.js'] } }), ['test/both.test.js', 'test/unreadable.test.js']);
  assert.deepEqual(interactingTests(closures, { ...sides, trunkAffected: { full: true, files: [] } }), ['test/both.test.js', 'test/unreadable.test.js']);
  assert.deepEqual(interactingTests(closures, { ...sides, trunkAffected: { full: false, files: [] } }), ['test/both.test.js']);
});
