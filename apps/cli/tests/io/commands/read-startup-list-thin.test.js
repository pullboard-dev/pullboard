/** @pullboard-test-input source-cell apps/cli packages/kernel packages/store packages/state packages/queue packages/seats packages/items packages/spec packages/git packages/verify packages/merge packages/config packages/stats packages/resources packages/transport packages/jobs packages/sandbox packages/doctrine packages/codemap packages/commits packages/roadmap */
/**
 * The list thin startup row is measured in a file of its own, so the other four rows and this one each fit their own timeout [C7,#10293].
 * Why: list and list thin together on an 800-seat board outran one file's time; assertStartupBudgets({ only }) lets each row run alone (#9477).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertStartupBudgets } from '../../fixtures/budget.js';
import ceilings from '../../../journeys/list/startup-budget.json' with { type: 'json' };

const startupReport = {};

test('clause 1: list thin alone holds its row in startup-budget.json, measured on its own with the bare node floor [C7,#10293]', async (t) => {
  await assertStartupBudgets(t, startupReport, { only: ['list thin'] });
  assert.deepEqual(Object.keys(startupReport.mediansMs), ['list thin']);
  assert.ok(startupReport.mediansMs['list thin'] < ceilings['list thin']);
});

// 'list thin' is an audited exception: the 100 ms target is out of reach for now, so the row sits at 200 ms against the measured
// median of 182 ms (run 91c72d73-2ba5-49e3-bff6-359ea1541783); the cut toward 100 is #9477, and the row never rises [C7,#9090].
test('clause 1: list thin is an audited exception at 200 ms over its measured median of 182 ms, run 91c72d73-2ba5-49e3-bff6-359ea1541783 [C7,#9090]', () => {
  assert.ok(182 < ceilings['list thin'] && ceilings['list thin'] === 200);
});
