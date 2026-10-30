/** Validate the explicit opt-in to speculative landing without changing serial defaults [B3,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../src/shell/config.js';

test('parallel candidate landing is opt-in and accepts only boolean settings [B3,V4]', () => {
  assert.notEqual(configFromSource('{}').landing?.parallel, true);
  for (const parallel of [true, false]) {
    assert.equal(configFromSource(JSON.stringify({ landing: { parallel } })).landing.parallel, parallel);
  }
  for (const parallel of [null, 1, 'true', [], {}]) {
    assert.throws(() => configFromSource(JSON.stringify({ landing: { parallel } })), { code: 'BAD_CONFIG', message: /landing\.parallel/u });
  }
});
