/** A runner that offers no browser refuses a pulled proof that needs one, instead of reading its skipped journeys as green [C7,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOLING } from '../../../tests/fixtures/pull.js';
import { servedWithoutBrowser } from '../../../tests/fixtures/pull.js';

test('clause 1: a runner with PULLBOARD_CHROME=none refuses a proof selection naming a browser-declared file BROWSER_UNAVAILABLE, never green [C7,P7]', { timeout: 150_000 }, // budget: one project, one submit and one served gate.
async t => {
  const browserPlan = { 'packages/gate/index.js': TOOLING['packages/gate/index.js'].replace("proofFiles: ['web/proof']", "proofFiles: ['web/browser.test.js']") };
  const gate = await servedWithoutBrowser(t, { path: 'web/browser.test.js', body: "// pullboard: browser\nimport { test } from 'node:test';\n" }, browserPlan);
  assert.equal(gate.green, false, JSON.stringify(gate));
  const refusal = gate.analysis.refusals.find(row => row.code === 'BROWSER_UNAVAILABLE');
  assert.ok(refusal, JSON.stringify(gate.analysis));
  assert.deepEqual(refusal.paths, ['web/browser.test.js']);
  assert.match(refusal.message, /web\/browser\.test\.js would skip to green/u);
  assert.deepEqual(gate.phases, [], 'no proof ran to skip its browser cases');
});
