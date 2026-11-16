/** A seat launches with its runtime's profile: a 1 h prompt cache where the profile asks, caching off for a self-hosted runtime [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seatLaunchConfig } from '../../../../packages/seats/index.js';

const LANE_TOOLS = ['read', 'edit', 'bash'];

test('clause 1: a seat launched for a runtime whose profile asks for a 1 h prompt cache gets that setting [C7]', () => {
  const launch = seatLaunchConfig({ runtime: 'claude', laneTools: LANE_TOOLS });
  assert.equal(launch.promptCache, '1h');
  assert.deepEqual(launch.cachedPrefix, ['instructions', 'skills', 'brief']);
  assert.deepEqual(launch.tools, LANE_TOOLS);
});

test('clause 2: a self-hosted runtime profile launches with caching off and the same lane tools [C7]', () => {
  const launch = seatLaunchConfig({ runtime: 'self-hosted-llm', laneTools: LANE_TOOLS });
  assert.equal(launch.promptCache, 'off');
  assert.deepEqual(launch.cachedPrefix, []);
  assert.deepEqual(launch.tools, LANE_TOOLS);
});
