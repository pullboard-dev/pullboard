/** Config validates vendor-neutral routine, standard and escalation tiers [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../src/io/main.js';
import { defaults } from '../src/io/main.js';

const TIERS = JSON.parse(`{
  "routine": { "endpoint": "http://gpu-a.lan:8000/v1", "model": "house-small" },
  "standard": { "endpoint": "http://gpu-b.lan:8000/v1", "model": "house-medium" },
  "escalation": { "endpoint": "http://gpu-c.lan:8000/v1", "model": "house-large" }
}`);

test('config.tiers-setting.clause-1-a-tiers-setting-naming-routine: clause 1: a tiers setting naming routine, standard and escalation tiers, each with a self-hosted endpoint, loads, and is off by default [C7]', () => {
  assert.deepEqual(configFromSource(JSON.stringify({ tiers: TIERS })).tiers, TIERS);
  assert.equal(defaults().tiers, undefined);
  assert.equal(configFromSource('{}').tiers, undefined);
});

test('config.tiers-setting.clause-2-a-tier-with-no-endpoint-or: clause 2: a tier with no endpoint or model is refused with the tier named [C7]', () => {
  for (const [tier, field] of [['standard', 'endpoint'], ['escalation', 'model']]) {
    const { [field]: omitted, ...rest } = TIERS[tier];
    assert.ok(omitted);
    assert.throws(() => configFromSource(JSON.stringify({ tiers: { ...TIERS, [tier]: rest } })),
      error => error.name === 'Refused' && error.code === 'BAD_CONFIG' && error.message.includes(`tier "${tier}" is missing its ${field}`));
  }
  assert.throws(() => configFromSource(JSON.stringify({ tiers: { routine: {} } })), /tier "routine" is missing its endpoint.*tier "routine" is missing its model/u);
});
