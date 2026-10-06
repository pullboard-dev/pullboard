/**
 * Routing by evidence (N18): what kind an item is, and which rungs of a ladder to try for it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { featuresOf, routePlan } from '../src/run.js';

test('an item is the kind its brief names, or the rules its sweep listed [N18]', () => {
  assert.deepEqual(featuresOf({ item_brief: 'Kind: wiring, test\nFiles:\n- a.js' }), ['test', 'wiring']);
  assert.deepEqual(featuresOf({ item_brief: 'Files:\n- a.js\nChange:\n- line 3:1 no-var: x\n- line 9 camelcase: y\n- line 12:2 no-var: z' }), ['camelcase', 'no-var']);
  assert.deepEqual(featuresOf({ item_brief: 'Files:\n- a.js' }), ['unlabelled']);
});

test('a rung is skipped only after failing a feature twice without ever fixing it, per tier [N18]', () => {
  const red = (features, command = 'small', tier = 'light') => ({ tier, command, features, result: 'red' });
  const green = (features, command = 'small', tier = 'light') => ({ tier, command, features, result: 'green' });
  const ladder = ['small', 'large'];
  assert.deepEqual(routePlan(ladder, ['camelcase'], 'light', []).map((step) => step.skip), ['', '']);
  assert.deepEqual(routePlan(ladder, ['camelcase'], 'light', [red(['camelcase'])]).map((step) => step.skip), ['', '']);
  const twice = [red(['camelcase', 'no-var']), red(['camelcase'])];
  assert.deepEqual(routePlan(ladder, ['camelcase', 'no-var'], 'light', twice).map((step) => step.skip), ['it failed camelcase 2 times and never fixed it', '']);
  assert.deepEqual(routePlan(ladder, ['no-var'], 'light', twice).map((step) => step.skip), ['', '']);
  assert.deepEqual(routePlan(ladder, ['camelcase'], 'light', [...twice, green(['camelcase'])]).map((step) => step.skip), ['', '']);
  assert.deepEqual(routePlan(ladder, ['camelcase'], 'mid', twice).map((step) => step.skip), ['', '']);
});
