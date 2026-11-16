/** Work routes by tier on a self-hosted-only project [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeByTier } from '../index.js';

const TIERS = JSON.parse(`{
  "routine": { "endpoint": "http://gpu-a.lan:8000/v1", "model": "house-small" },
  "standard": { "endpoint": "http://gpu-b.lan:8000/v1", "model": "house-medium" },
  "escalation": { "endpoint": "http://gpu-c.lan:8000/v1", "model": "house-large" }
}`);

test('clause 1: a project whose tiers name only self-hosted endpoints routes a routine item to the routine tier and an escalation item to the escalation tier [C7]', () => {
  assert.deepEqual(routeByTier(TIERS, {}), { tier: 'routine', ...TIERS.routine });
  assert.deepEqual(routeByTier(TIERS, { escalation: true }), { tier: 'escalation', ...TIERS.escalation });
  assert.deepEqual(routeByTier(TIERS, { bounces: 2 }), { tier: 'escalation', ...TIERS.escalation });
  assert.deepEqual(routeByTier(TIERS, { tier: 'standard', escalation: true }), { tier: 'standard', ...TIERS.standard });
  assert.equal(routeByTier(undefined, {}), null);
  assert.equal(routeByTier({ standard: TIERS.standard }, {}), null);
});
