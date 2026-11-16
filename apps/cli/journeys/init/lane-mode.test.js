/** The laneMode setting is on for a fresh board, accepts off, and refuses any other value [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/index.js';
import { defaults } from '../../../../packages/config/index.js';

test('clause 1: a fresh board reports laneMode on by default, and the lane map key is untouched [C7]', () => {
  assert.equal(defaults().laneMode, 'on');
  assert.equal(configFromSource('{}').laneMode, 'on');
  assert.deepEqual(configFromSource('{}').lanes, {});
});

test('clause 2: setting laneMode off is accepted and read back as off, and any other value is refused [C7]', () => {
  assert.equal(configFromSource(JSON.stringify({ laneMode: 'off' })).laneMode, 'off');
  assert.equal(configFromSource(JSON.stringify({ laneMode: 'on' })).laneMode, 'on');
  for (const bad of ['maybe', true, false, 0, null, 'OFF']) {
    assert.throws(() => configFromSource(JSON.stringify({ laneMode: bad })), /laneMode/u, String(bad));
  }
});
