/** @pullboard-test-input source-cell api */
/** sameTimingRed excuses only a timing-table case that fails on both gate and main under one name [C7,#9754]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameTimingRed } from '../../../src/logic/gate/timing-reds.js';

const FILE = 'apps/cli/tests/io/commands/read-startup.test.js';
const NAME = 'clause 1: read startup stays under 200 ms';

test('api.gate-timing-reds.sametimingred-true-read-startup-clause: clause 1: sameTimingRed is true for read-startup clause 1 failing on gate and main with different measured numbers [C7,#9754]', () => {
  const gate = { file: FILE, name: NAME, message: 'startup took 423 ms', signature: 'a' };
  const main = { file: FILE, name: NAME, message: 'startup took 182 ms', signature: 'b' };
  assert.equal(sameTimingRed(gate, main), true);
});

test('api.gate-timing-reds.sametimingred-false-case-outside-timing: clause 2: sameTimingRed is false for a case outside the timing row table [C7,#9754]', () => {
  const other = { file: 'packages/api/tests/claim.test.js', name: 'clause 1: claims' };
  assert.equal(sameTimingRed(other, other), false);
  const sameFileOtherCase = { file: FILE, name: 'clause 2: something else' };
  assert.equal(sameTimingRed(sameFileOtherCase, sameFileOtherCase), false);
});

test('api.gate-timing-reds.sametimingred-false-when-two-case: clause 3: sameTimingRed is false when the two case names differ [C7,#9754]', () => {
  const gate = { file: FILE, name: NAME };
  const main = { file: FILE, name: 'clause 1: another wording' };
  assert.equal(sameTimingRed(gate, main), false);
});

test('api.gate-timing-reds.sametimingred-true-store-light-load: clause 4: sameTimingRed is true for the store light-door cold-load case failing on gate and main under one name, and false for another case of that file [C7,#11815]', () => {
  const file = 'packages/store/tests/io/light-load.test.js';
  const name = 'store.io-light-load.packages-store-light-js-loads-cold: clause 2: packages/store/light.js loads cold in under 100 ms of module work [C7]';
  assert.equal(sameTimingRed({ file, name, signature: 'a' }, { file, name, signature: 'b' }), true);
  const other = { file, name: 'store.io-other.something: clause 1: something else' };
  assert.equal(sameTimingRed(other, other), false);
});
