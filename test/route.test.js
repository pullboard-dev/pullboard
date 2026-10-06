/**
 * Routing by evidence (N18): what kind an item is, and which rungs of a ladder to try for it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { featuresOf, routePlan } from '../src/run.js';

test('an item is the kind its brief names, or the rules its sweep listed [N18]', () => {
  assert.deepEqual(featuresOf({ item_brief: 'Kind: wiring, test\nFiles:\n- a.js' }), ['test', 'wiring']);
  assert.deepEqual(featuresOf({ item_brief: 'Files:\n- a.js\nChange:\n- line 3:1 no-var: x\n- line 9 camelcase: y\n- line 12:2 no-var: z' }), ['camelcase', 'no-var']);
  assert.deepEqual(featuresOf({ item_brief: 'Files:\n- a.js\nChange:\n- line 17:3: camelcase Name variables in camelCase.\n- line 9: Missing a semicolon' }), ['camelcase']);
  assert.deepEqual(featuresOf({ item_brief: 'Files:\n- a.js' }), ['unlabelled']);
});

test('a rung is skipped when it fixed fewer than half of at least two items sharing a feature, per tier [N18]', () => {
  const red = (features, command = 'small', tier = 'light') => ({ tier, command, features, result: 'red' });
  const green = (features, command = 'small', tier = 'light') => ({ tier, command, features, result: 'green' });
  const ladder = ['small', 'large'];
  const skips = (features, tier, records) => routePlan(ladder, features, tier, records).map((step) => step.skip);
  assert.deepEqual(skips(['camelcase'], 'light', []), ['', '']);
  assert.deepEqual(skips(['camelcase'], 'light', [red(['camelcase'])]), ['', '']);
  const twice = [red(['camelcase', 'no-var']), red(['camelcase'])];
  assert.deepEqual(skips(['camelcase', 'no-var'], 'light', twice), ['it fixed 0 of 2 items with camelcase', '']);
  assert.deepEqual(skips(['no-var'], 'light', twice), ['', '']);
  assert.deepEqual(skips(['camelcase'], 'light', [...twice, green(['camelcase'])]), ['it fixed 1 of 3 items with camelcase', '']);
  assert.deepEqual(skips(['camelcase'], 'light', [...twice, green(['camelcase']), green(['camelcase'])]), ['', '']);
  assert.deepEqual(skips(['camelcase'], 'mid', twice), ['', '']);
  assert.deepEqual(skips(['camelcase'], 'light', [red(['camelcase'], 'large'), red(['camelcase'], 'large')]), ['', 'it fixed 0 of 2 items with camelcase']);
});
