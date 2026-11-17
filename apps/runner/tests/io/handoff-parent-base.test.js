/** The runner hand-off passes the ticket's parent base to requireSubmitComposition, so a head already in main history is accepted (follow-up of #9445) [C7,V4,#9512]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { runHandoffStages } from '../../src/io/handoff.js';

const quiet = async () => {};
const others = { authorization: quiet, doctrine: quiet, cells: quiet, criterion: quiet, proof: quiet };

/** The real rule's shape: a head in main history composes only when the parent base is passed (packages/items composition.js). */
const composition = calls => ({ requireSubmitComposition(root, candidate, trunk, expectedMain, parentBase = null) {
  calls.push({ candidate, trunk, expectedMain, parentBase });
  if (!parentBase) throw Object.assign(new Error('MAIN_NOT_COMPOSED'), { code: 'MAIN_NOT_COMPOSED' });
} });

/** Run the hand-off with a composition ticket and return the result and the recorded calls. */
async function handoff(extra) {
  const fixture = privateFixtureFiles('pb-handoff-base-');
  fixture.write('runner.log', '');
  const calls = [];
  const input = { job: 'j1', commit: 'head1', main: 'main1', trunk: 'main1', composition: 'head1', ...extra };
  const result = await runHandoffStages(fixture.root, input, { logFile: join(fixture.root, 'runner.log'), services: { composition: composition(calls) }, stages: others });
  return { result, calls };
}

test('clause 1: a head already in main history is accepted because the ticket base reaches requireSubmitComposition [C7,V4]', async () => {
  const { result, calls } = await handoff({ base: 'parent1' });
  assert.equal(result.green, true);
  assert.deepEqual(calls, [{ candidate: 'head1', trunk: { commit: 'main1' }, expectedMain: 'main1', parentBase: 'parent1' }]);
});

test('clause 1: a ticket with no base still reaches the rule with no parent base, so the old refusal holds [C7,V4]', async () => {
  const { result, calls } = await handoff({});
  assert.equal(result.green, false);
  assert.equal(calls[0].parentBase, null);
});
