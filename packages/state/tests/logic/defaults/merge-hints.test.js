/** The MACHINE_CLAUSE_RED and STALE_VERDICT next lines ask for a submit and a re-review, never for a main merge, worded true with submit.composeAsObject on or off [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_NEXT_STEPS } from '../../../src/logic/defaults.js';
import { SUBMIT_REACHED_REFUSALS } from '../../../src/logic/machine/shared.js';

const MERGE_MAIN = /merge (current |the latest )?main/u;

test('state.defaults-merge-hints.machine-clause-red-says-submit-again: clause 1: the MACHINE_CLAUSE_RED next line says fix the failing command, commit and submit again (submit composes current main), with no merge main [C7]', () => {
  const line = DEFAULT_NEXT_STEPS.MACHINE_CLAUSE_RED;
  assert.match(line, /fix the failing command/u);
  assert.match(line, /commit and submit again \(submit composes current main\)/u);
  assert.doesNotMatch(line, MERGE_MAIN);
  assert.doesNotMatch(line, /composeAsObject/u, 'the line never names the setting, so it holds with it on or off');
});

test('state.defaults-merge-hints.stale-verdict-asks-for-re-review: clause 2: the STALE_VERDICT next line asks for a re-review against current main without telling the builder to merge main [C7]', () => {
  const refusal = SUBMIT_REACHED_REFUSALS.find((row) => row.code === 'STALE_VERDICT');
  assert.ok(refusal, 'the submit-reached refusals carry STALE_VERDICT');
  assert.match(refusal.next, /run pullboard submit again/u);
  assert.match(refusal.next, /re-review it against current main/u);
  assert.doesNotMatch(refusal.next, MERGE_MAIN);
  assert.doesNotMatch(refusal.next, /composeAsObject/u, 'the line never names the setting, so it holds with it on or off');
});
