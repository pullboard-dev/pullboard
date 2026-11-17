/** The board state's stage limits come from the settings that govern each stage, and a stage with no setting is absent [#6940]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../../../config/index.js';
import { stageLimits } from '../../../src/logic/clock.js';

test('store.logic-board-stage-limits.a2-clause-1-stagelimits-reads-each: [A2] clause 1: stageLimits reads each stage from its own setting, never a constant [#6940]', () => {
  const config = configFromSource(JSON.stringify({ itemBuildBudgetMinutes: 12.5, review: { starveMinutes: 9 }, check: { timeout: '7m' }, reviewLease: '45m', landing: { timeout: '20m' } }));
  assert.deepEqual(stageLimits(config), { building: 12.5, gate: 7, 'pending review': 9, 'in review': 45, landing: 20 });
  const changed = configFromSource(JSON.stringify({ itemBuildBudgetMinutes: 3, review: { starveMinutes: 2 }, check: { timeout: '1h' } }));
  assert.equal(stageLimits(changed).building, 3);
  assert.equal(stageLimits(changed)['pending review'], 2);
  assert.equal(stageLimits(changed).gate, 60);
});

test('store.logic-board-stage-limits.a2-clause-2-a-stage-with: [A2] clause 2: a stage with no setting is absent from stageLimits, not defaulted [#6940]', () => {
  const limits = stageLimits(configFromSource('{}'));
  assert.equal(Object.hasOwn(limits, 'landing'), false, 'no landing.timeout, no landing limit');
  assert.equal(Object.hasOwn(limits, 'ready'), false, 'no setting governs ready');
  assert.deepEqual(stageLimits({}), {});
});
