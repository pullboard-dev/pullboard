/** @pullboard-test-input packages/seats/src/logic/tiers.json packages/config/src/io/main.js */
/** @pullboard-world-pin reads the committed seats tier table to prove it agrees with the config route table. */
/** @pullboard-test-loads packages/config/src/io/main.js */
/** The two model tier tables agree, and Sonnet seats get the strong route [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaults } from '../src/io/main.js';
import { readFileSync } from 'node:fs';

const MODEL_TIERS = JSON.parse(readFileSync(new URL('../../seats/src/logic/tiers.json', import.meta.url), 'utf8'));

/** The claim rule (apps/cli/src/io/route.js modelTierRoute): the longest matching fragment wins; no match is mid. */
function modelTierRoute(model, tiers) {
  const label = model.toLowerCase();
  const hits = tiers.filter(entry => label.includes(entry.contains.toLowerCase()));
  if (!hits.length) return 'mid';
  const longest = Math.max(...hits.map(entry => entry.contains.length));
  return hits.find(entry => entry.contains.length === longest).route;
}

test('config.model-tiers.clause-1-a-seat-joined-as-claude-sonnet: clause 1: a seat joined as claude-sonnet-5-5 resolves to the strong route [C7]', () => {
  assert.equal(modelTierRoute('claude-sonnet-5-5', defaults().modelTiers), 'strong');
});

test('config.model-tiers.clause-2-for-every-label-in-seats-tiers: clause 2: for every label in seats tiers.json, model-tiers.json gives the same route [C7]', () => {
  const tiers = defaults().modelTiers;
  for (const [label, { route }] of Object.entries(MODEL_TIERS)) assert.equal(modelTierRoute(label, tiers), route, label);
});
