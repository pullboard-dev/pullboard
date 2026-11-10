/** The API refuses a review from a reviewer who is not on the submitted commit, and answers 200 once they are (A2, N26). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apiHttpBox as httpBox,
  commitWork,
  checkOutSubmitted,
  FIXTURE_BRIEF,
} from '../../../tests/fixtures/api.js';
import {
  FIXTURE_MODEL,
  FIXTURE_MODEL_EARLIER,
} from '../../../tests/fixtures/testkit.js';

test('[A2, N26] a review through the API needs the reviewer on the submitted commit, and answers 200 once it is [#3757]', async (t) => {
  const box = await httpBox(t);
  const builder = box.cli(box.root, 'worktree', 'app', '--model', FIXTURE_MODEL, '--family', 'codex');
  const verifier = box.cli(box.root, 'worktree', 'app', '--model', FIXTURE_MODEL_EARLIER, '--family', 'claude');
  const added = await box.call(box.path + '/moves', { verb: 'add', args: { lane: 'app', title: 'Default policy item', criterion: 'complete', specs: 'G1', brief: FIXTURE_BRIEF } });
  assert.equal(added.status, 200, JSON.stringify(added.document));
  const id = added.document.result.item.item_id;
  assert.equal((await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: builder.agent })).status, 200);
  commitWork(box, builder, id);
  assert.equal((await box.call(box.path + '/moves', { verb: 'submit', item: id, agent: builder.agent })).status, 200);
  const refusal = await box.call(box.path + '/moves', { verb: 'verify', item: id, agent: verifier.agent, args: { decision: 'accept', reason: 'CRITERION_MET', note: 'not checked out' } });
  assert.equal(refusal.status, 409, JSON.stringify(refusal.document));
  assert.equal(refusal.document.error.code, 'NOT_AT_COMMIT', 'the default refuses a reviewer who is not on the submitted commit');
  checkOutSubmitted(box, builder, verifier);
  const ready = await box.call(box.path + '/moves', { verb: 'next', agent: verifier.agent, args: { verify: true } });
  assert.equal(ready.status, 200, JSON.stringify(ready.document));
});
