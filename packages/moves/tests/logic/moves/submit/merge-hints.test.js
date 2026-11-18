/** Only a real conflict hint tells a builder to merge main; the not-composed and stale-verdict hints ask for a submit and a re-review, worded true with submit.composeAsObject on or off [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANDING_NEXT } from '../../../../src/logic/table/next.js';
import submit from '../../../../src/logic/moves/submit.js';
import verify from '../../../../src/logic/moves/verify.js';

const MERGE_MAIN = /merge (current |the latest )?main/u;

test('moves.submit-merge-hints.main-not-composed-says-submit-again: clause 1: the MAIN_NOT_COMPOSED hint says run pullboard submit again because submit composes current main, and no longer says to merge main into the candidate [C7]', () => {
  const hint = submit.nextSteps.MAIN_NOT_COMPOSED;
  assert.match(hint, /run pullboard submit again/u);
  assert.match(hint, /composes current main/u);
  assert.doesNotMatch(hint, MERGE_MAIN);
  assert.doesNotMatch(hint, /composeAsObject/u, 'a hint never names the setting, so it holds with the setting on or off');
});

test('moves.submit-merge-hints.stale-verdict-asks-for-re-review: clause 2: the STALE_VERDICT and VERDICT_TRUNK_MOVED hints and the STALE_VERDICT next line ask for a re-review against main without telling the builder to merge main [C7]', () => {
  const hints = { 'verify STALE_VERDICT': verify.nextSteps.STALE_VERDICT, 'verify VERDICT_TRUNK_MOVED': verify.nextSteps.VERDICT_TRUNK_MOVED, 'next STALE_VERDICT': LANDING_NEXT.STALE_VERDICT };
  for (const [name, text] of Object.entries(hints)) {
    assert.match(text, /submit/u, `${name} names the submit that composes main`);
    assert.match(text, /re-review|verify again/u, `${name} asks for a re-review`);
    assert.match(text, /current main|latest main/u, `${name} names the main the re-review is against`);
    assert.doesNotMatch(text, MERGE_MAIN, `${name} does not ask for a merge`);
    assert.doesNotMatch(text, /composeAsObject/u, `${name} does not name the setting`);
  }
});

test('moves.submit-merge-hints.merge-conflict-still-says-merge-main: clause 3: every MERGE_CONFLICT hint still says to merge main and resolve the conflict [C7]', () => {
  for (const [name, table] of Object.entries({ submit: submit.nextSteps, verify: verify.nextSteps })) {
    assert.match(table.MERGE_CONFLICT, /merge main into your branch, resolve the conflicts/u, `${name} MERGE_CONFLICT keeps its merge instruction`);
  }
});
