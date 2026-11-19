/** A file is quiet when its conflict rate is under the threshold [C7,#11084]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quietFiles } from '../../src/logic/contention.js';

test('items.quiet.under-threshold: clause 1: quietFiles(files, rates, threshold) returns the files whose rate in the rates map is under threshold, treats a file with no rate as quiet, and leaves out a file at or over threshold [C7,#11084]', () => {
  const rates = new Map([['a.js', 1], ['b.js', 3], ['c.js', 5]]);
  assert.deepEqual(quietFiles(['a.js', 'b.js', 'c.js', 'new.js'], rates, 3), ['a.js', 'new.js']);
  assert.deepEqual(quietFiles([], rates, 3), []);
});
