/** @pullboard-test-input packages/gate/src/io/run-tests.js */
/** @pullboard-world-pin: clause 1 reads the run-tests source to prove main takes browser and gui from the plan before it calls either admission read. */
/** A shard run takes its browser and GUI needs from a shipped plan and skips both selections [C7,#11829]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SHARD_PLAN_ENV } from '../../src/io/run-tests-plan.js';
import { shardPlan } from '../../src/io/run-tests-plan.js';

const SOURCE = readFileSync(new URL('../../src/io/run-tests.js', import.meta.url), 'utf8');

test('gate.run-tests-plan.valid-plan-skips-selection: clause 1: a valid PULLBOARD_SHARD_PLAN gives browser and gui, and main reads admission only without one [C7,#11829]', () => {
  assert.deepEqual(shardPlan({ [SHARD_PLAN_ENV]: '{"browser":false,"gui":true}' }), { browser: false, gui: true });
  assert.deepEqual(shardPlan({ [SHARD_PLAN_ENV]: '{"browser":true,"gui":false,"extra":1}' }), { browser: true, gui: false });
  assert.match(SOURCE, /const plan = shardPlan\(environment\.all\(\)\);\s+let browser = plan \? plan\.browser : fullSuite;\s+if \(!browser && !plan\) \{\s+const \{ testsNeedBrowser \}/u, 'main asks the plan first and reads browser admission only when there is none');
  assert.match(SOURCE, /const gui = plan \? plan\.gui : \(await import\('\.\/gui\/admission\.js'\)\)\.testsNeedGui\(/u, 'main takes gui from the plan and loads GUI admission only when there is none');
  assert.equal([...SOURCE.matchAll(/testsNeedGui\(/gu)].length, 1, 'testsNeedGui has one call, behind the plan');
});

test('gate.run-tests-plan.no-plan-computes-both: clause 2: with the variable unset or invalid there is no plan, so main computes both as before [C7,#11829]', () => {
  for (const value of [undefined, '', 'not json', '[]', 'null', '{}', '{"browser":true}', '{"gui":false}', '{"browser":"yes","gui":false}', '{"browser":1,"gui":0}']) {
    assert.equal(shardPlan(value === undefined ? {} : { [SHARD_PLAN_ENV]: value }), null, String(value));
  }
});
