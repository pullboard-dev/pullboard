/** The red-now list is computed only from recorded ledger rows, with no live test run [P7,C7,U152]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redNow } from '../index.js';

const row = (file, status, at, inputKey = 'k1', context = 'ctx') => ({ file, command: 'proof', context, status, inputKey, commit: 'c'.repeat(40), receipt: `r${at}`, origin: 'run', at });

test('gate.red-now.red-now-list-computed-only: clause 1: the red-now list is computed only from recorded ledger rows, with no live test run [P7,C7]', () => {
  const rows = [row('a.test.js', 'fail', 10), row('b.test.js', 'fail', 11), row('b.test.js', 'pass', 20, 'k2'), row('c.test.js', 'pass', 5), { ...row('d.test.js', 'fail', 9), command: 'other' }];
  const reds = redNow(rows);
  assert.deepEqual(reds.map(red => red.file), ['a.test.js']);
  assert.deepEqual(redNow([...rows].reverse()), reds, 'row order never changes the answer');
  assert.throws(() => redNow(async () => []), TypeError, 'a runner is never accepted in place of rows');
  const source = redNow.toString();
  assert.doesNotMatch(source, /\bspawn|\bexec|child_process|await\b/u, 'the module body launches nothing');
});
