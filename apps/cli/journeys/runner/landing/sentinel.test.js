/** A job claimed 3 times within 60 s shouts the coordinator once, naming the job and its runners (#7445) [C7,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { addItem } from '../../../../../packages/store/index.js';
import { register } from '../../../../../packages/store/index.js';
import { FIXTURE_MODEL } from '../../../tests/fixtures/testkit.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';

const SHA = 'a'.repeat(40);

/** A board with one open land job, and a claim-and-release call by runner and second. */
function landBoard(t) {
  const board = cellBoard(t, ':memory:');
  register(board, { lane: 'coordinator', path: '/nowhere', route: 'strong', model: FIXTURE_MODEL });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Item one', criterion: 'The item lands.' });
  const job = offerLandingJob(board.db, { items: [{ id, commit: SHA, ref: 'refs/heads/item/1' }], expect: SHA, config: { trunk: { remote: '/nowhere/trunk.git' } }, now: 0 });
  const call = (body, now) => boardJobQueueCall(board, body, { mode: 'pull', now, drained: () => [] });
  /** Claim at a second, then free the job at once as a draining runner would, so the next claim can come at once. */
  const claimAndFree = (runner, now) => {
    const { claim } = call({ action: 'claim', runner, capabilities: [], kinds: ['land'] }, now);
    if (claim) boardJobQueueCall(board, { action: 'release', job: claim.job, runner, token: claim.token, backoff: false }, { mode: 'pull', now, drained: () => [runner] });
    return claim;
  };
  const shouts = () => board.db.prepare("SELECT shout_text AS text FROM shout WHERE shout_text LIKE '% was claimed % times in 60 s%'").all();
  return { board, job, claimAndFree, shouts };
}

test('#7445 clause 1: the third claim of one job within 60 s shouts the coordinator once, naming the job and its runners [C7]', t => {
  const box = landBoard(t);
  assert.ok(box.claimAndFree('r-one', 1_000));
  assert.ok(box.claimAndFree('r-two', 2_000));
  assert.equal(box.shouts().length, 0, 'two claims are not a runaway');
  assert.ok(box.claimAndFree('r-one', 3_000));
  const shouts = box.shouts();
  assert.equal(shouts.length, 1, 'the third claim shouts');
  assert.ok(shouts[0].text.includes(box.job.id), shouts[0].text);
  assert.match(shouts[0].text, /r-one/u);
  assert.match(shouts[0].text, /r-two/u);
});

test('#7445 clause 2: further claims of the same job in that window add no second shout [C7]', t => {
  const box = landBoard(t);
  for (const second of [1, 2, 3, 4, 5, 6]) box.claimAndFree('r-one', second * 1_000);
  assert.equal(box.shouts().length, 1);
});

test('#7445 clause 1: claims spread over more than 60 s never shout [C7]', t => {
  const box = landBoard(t);
  for (const second of [1, 30, 61, 91, 121]) assert.ok(box.claimAndFree('r-one', second * 1_000), `claim at ${second} s`);
  assert.equal(box.shouts().length, 0);
});
