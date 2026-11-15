/** pushGate.sizeFromBoard is a boolean setting, off by default, refused when not a boolean, and described [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configProblems } from '../../src/io/main.js';
import { defaults } from '../../src/io/main.js';
import { describeSetting } from '../../src/io/settings/descriptions.js';

const withValue = value => ({ ...defaults(), pushGate: { ...defaults().pushGate, sizeFromBoard: value } });

test('clause 1: pushGate.sizeFromBoard is accepted as true or false and is false by default [C7]', () => {
  assert.equal(defaults().pushGate.sizeFromBoard, false);
  for (const value of [true, false]) assert.deepEqual(configProblems(withValue(value)), []);
});

test('clause 2: a non-boolean pushGate.sizeFromBoard is refused with a message naming the setting [C7]', () => {
  for (const value of ['yes', 1, null]) {
    assert.ok(configProblems(withValue(value)).some(problem => problem.includes('pushGate.sizeFromBoard')), String(value));
  }
});

test('clause 3: pushGate.sizeFromBoard has a settings description row [C7]', () => {
  assert.match(JSON.stringify(describeSetting('pushGate.sizeFromBoard')), /shard count/u);
});
