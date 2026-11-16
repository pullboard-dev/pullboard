/** @pullboard-test-loads packages/config/src/io/main.js */
/** The pace setting takes sprint, steady or strict and defaults to steady, today's behaviour [O6]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../src/io/main.js';

test('clause 1: a board with no pace setting reads pace as steady, and sprint, steady and strict are each accepted [O6]', () => {
  assert.equal(configFromSource('{}').pace, 'steady');
  for (const pace of ['sprint', 'steady', 'strict']) assert.equal(configFromSource(JSON.stringify({ pace })).pace, pace);
});

test('clause 2: any other pace value is refused by the settings check with a problem naming sprint, steady and strict [O6]', () => {
  for (const pace of ['fast', '', 'Steady', 1, null]) {
    assert.throws(() => configFromSource(JSON.stringify({ pace })), error => error.code === 'BAD_CONFIG'
      && /"pace"/u.test(error.message) && /sprint/u.test(error.message) && /steady/u.test(error.message) && /strict/u.test(error.message));
  }
});
