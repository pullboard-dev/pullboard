/** The census job length self-tunes from the last census's shard wall times, as a pure function [C7,U151,#9392]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selfTunedJobMinutes } from '../../src/logic/census-tune.js';

const MIN = 60_000;

test('clause 1: selfTunedJobMinutes is null under 4 shard times, else the 80th percentile in whole minutes kept between 3 and 20 [C7,U151]', () => {
  assert.equal(selfTunedJobMinutes([5 * MIN, 6 * MIN, 7 * MIN]), null);
  assert.equal(selfTunedJobMinutes([]), null);
  assert.equal(selfTunedJobMinutes(undefined), null);
  assert.equal(selfTunedJobMinutes([4 * MIN, 5 * MIN, 6 * MIN, 7 * MIN, 8 * MIN]), 7, 'nearest-rank p80 of five');
  assert.equal(selfTunedJobMinutes([MIN, MIN, MIN, MIN]), 3, 'the floor');
  assert.equal(selfTunedJobMinutes([50 * MIN, 50 * MIN, 50 * MIN, 50 * MIN]), 20, 'the ceiling');
  assert.equal(selfTunedJobMinutes([4 * MIN + 31_000, 5 * MIN, 5 * MIN, 5 * MIN]), 5, 'whole minutes');
  assert.equal(selfTunedJobMinutes([0, NaN, 5 * MIN, 5 * MIN, 5 * MIN]), null, 'unusable times do not count');
});

test('clause 2: one extreme shard moves the result by at most the clamp, and arrival order does not matter [C7,U151]', () => {
  const base = [5, 5, 6, 6, 6, 7, 7, 7, 7, 8].map(m => m * MIN);
  const median = 6.5 * MIN;
  const withExtreme = [...base.slice(1), 10 * median];
  const plain = selfTunedJobMinutes(base);
  const moved = selfTunedJobMinutes(withExtreme);
  assert.ok(Math.abs(moved - plain) <= 20 - 3, 'within the clamp range');
  assert.ok(moved >= 3 && moved <= 20);
  const shuffled = [...withExtreme].reverse().sort((a, b) => (a % 7) - (b % 7));
  assert.equal(selfTunedJobMinutes(shuffled), moved);
  assert.equal(selfTunedJobMinutes(withExtreme.reverse()), moved);
});
