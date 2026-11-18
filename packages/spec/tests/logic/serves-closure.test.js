/** @pullboard-test-input source-cell spec */
/** The rows resting on a rejected row are listed nearest first, once each [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { servesClosure } from '../../src/logic/row/closure.js';

const row = (id, serves = []) => ({ id, serves });

test('clause 1: servesClosure lists I1 then I3 nearest first and leaves an unrelated row out [C7]', () => {
  const spec = { rows: [row('F2'), row('I3', ['I1']), row('I1', ['F2']), row('X9', ['F1']), row('F1')] };
  assert.deepEqual(servesClosure(spec, 'F2'), ['I1', 'I3']);
});

test('clause 2: a diamond lists the shared row once and an unknown id is empty [C7]', () => {
  const spec = { rows: [row('F2'), row('A', ['F2']), row('B', ['F2']), row('D', ['A', 'B'])] };
  assert.deepEqual(servesClosure(spec, 'F2'), ['A', 'B', 'D']);
  assert.deepEqual(servesClosure(spec, 'ZZ'), []);
});
