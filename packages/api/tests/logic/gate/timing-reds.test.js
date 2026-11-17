/** @pullboard-test-input source-cell api */
/** sameTimingRed excuses only a timing-table case that fails on both gate and main under one name [C7,#9754]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameTimingRed } from '../../../src/logic/gate/timing-reds.js';

const FILE = 'apps/cli/tests/io/commands/read-startup.test.js';
const NAME = 'clause 1: read startup stays under 200 ms';

test('clause 1: sameTimingRed is true for read-startup clause 1 failing on gate and main with different measured numbers [C7,#9754]', () => {
  const gate = { file: FILE, name: NAME, message: 'startup took 423 ms', signature: 'a' };
  const main = { file: FILE, name: NAME, message: 'startup took 182 ms', signature: 'b' };
  assert.equal(sameTimingRed(gate, main), true);
});

test('clause 2: sameTimingRed is false for a case outside the timing row table [C7,#9754]', () => {
  const other = { file: 'packages/api/tests/claim.test.js', name: 'clause 1: claims' };
  assert.equal(sameTimingRed(other, other), false);
  const sameFileOtherCase = { file: FILE, name: 'clause 2: something else' };
  assert.equal(sameTimingRed(sameFileOtherCase, sameFileOtherCase), false);
});

test('clause 3: sameTimingRed is false when the two case names differ [C7,#9754]', () => {
  const gate = { file: FILE, name: NAME };
  const main = { file: FILE, name: 'clause 1: another wording' };
  assert.equal(sameTimingRed(gate, main), false);
});
