/** A land job a runner cannot finish is re-claimed with backoff and released to the lane after a bounded count, never in a tight loop (#7386) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { openLandingJob } from '../../../../../packages/api/index.js';
import { addItem } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { itemThread } from '../../../../../packages/store/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';

const SHA = 'a'.repeat(40);
const HOUR = 3_600_000;

test('#7386 clause 1: a runner that releases every land claim is claimed at most a few times in 3.5 hours, then the job ends released and its item stays accepted [C7]', t => {
  const board = cellBoard(t, ':memory:');
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Item one', criterion: 'The item lands.' });
  const job = offerLandingJob(board.db, { items: [{ id, commit: SHA, ref: 'refs/heads/item/1' }], expect: SHA, config: { trunk: { remote: '/nowhere/trunk.git' } }, now: 0 });
  const call = (body, now) => boardJobQueueCall(board, body, { mode: 'pull', now });
  // The loop of 12 Nov: every runner claim ends in a release, and the runner asks again at once, once a second.
  let claims = 0, ended = null;
  for (let now = 1_000; now <= 3.5 * HOUR && !ended; now += 1_000) {
    const { claim } = call({ action: 'claim', runner: 'r-one', capabilities: [], kinds: ['land'] }, now);
    if (!claim) continue;
    claims += 1;
    const answer = call({ action: 'release', job: claim.job, runner: 'r-one', token: claim.token, reason: 'could not fetch the item' }, now);
    if (answer.gaveUp) ended = answer;
  }
  assert.ok(ended, `the job ends released within 3.5 hours after ${claims} claims`);
  assert.ok(claims <= 8, `bounded: ${claims} claims`);
  assert.ok(claims >= 2, 'it backed off between claims rather than giving up on the first');
  const rows = board.db.prepare("SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ? AND job_step_name = 'claimed'").get(job.id).n;
  assert.equal(rows, claims, 'one claimed step per claim, and none after');
  assert.equal(jobView(board.db, job.id).step, 'done');
  assert.equal(openLandingJob(board.db), null, 'no land job stays open to be re-claimed');
  assert.equal(call({ action: 'claim', runner: 'r-two', capabilities: [], kinds: ['land'] }, 3.5 * HOUR + 1).claim, null);
  assert.equal(getItem(board, id).item_merged_commit ?? null, null);
  const notes = itemThread(board, id).filter(entry => /released to the lane/u.test(entry.text ?? ''));
  assert.equal(notes.length, 1, JSON.stringify(itemThread(board, id)));
  assert.match(notes[0].text, /could not fetch the item/u);
});

test('#7386 clause 1: each release backs off longer, so no two claims of one land job are under 30 seconds apart [C7]', t => {
  const board = cellBoard(t, ':memory:');
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Item one', criterion: 'The item lands.' });
  offerLandingJob(board.db, { items: [{ id, commit: SHA, ref: 'refs/heads/item/1' }], expect: SHA, config: { trunk: { remote: '/nowhere/trunk.git' } }, now: 0 });
  const call = (body, now) => boardJobQueueCall(board, body, { mode: 'pull', now });
  const at = [];
  for (let now = 1_000; now <= HOUR && at.length < 5; now += 1_000) {
    const { claim } = call({ action: 'claim', runner: 'r-one', capabilities: [], kinds: ['land'] }, now);
    if (!claim) continue;
    at.push(now);
    call({ action: 'release', job: claim.job, runner: 'r-one', token: claim.token, reason: 'busy' }, now);
  }
  assert.equal(at.length, 5);
  const gaps = at.slice(1).map((value, index) => value - at[index]);
  assert.ok(gaps.every((gap, index) => gap >= 30_000 && (index === 0 || gap >= gaps[index - 1])), `gaps grow: ${gaps}`);
});
