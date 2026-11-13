/** A land job a runner keeps handing back is re-claimed with backoff, at most 12 times, then ends as a runaway and its items wait in the lane (#7386) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { openLandingJob } from '../../../../../packages/api/index.js';
import { addItem } from '../../../../../packages/store/index.js';
import { register } from '../../../../../packages/store/index.js';
import { FIXTURE_MODEL } from '../../../tests/fixtures/testkit.js';
import { getItem } from '../../../../../packages/store/index.js';
import { itemThread } from '../../../../../packages/store/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';

const SHA = 'a'.repeat(40);
const HOUR = 3_600_000;

/** A board with one accepted item and its open land job, and a call that drives the queue at a given time. */
function landBoard(t, { drained = () => [] } = {}) {
  const board = cellBoard(t, ':memory:');
  register(board, { lane: 'coordinator', path: '/nowhere', route: 'strong', model: FIXTURE_MODEL });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Item one', criterion: 'The item lands.' });
  const job = offerLandingJob(board.db, { items: [{ id, commit: SHA, ref: 'refs/heads/item/1' }], expect: SHA, config: { trunk: { remote: '/nowhere/trunk.git' } }, now: 0 });
  const call = (body, now) => boardJobQueueCall(board, body, { mode: 'pull', now, drained });
  return { board, id, job, call };
}

/** The loop of 12 Nov: a runner claims, hands the job back, and asks again once a second, for 3.5 hours. */
function loopFor(box, release) {
  let claims = 0;
  for (let now = 1_000; now <= 3.5 * HOUR; now += 1_000) {
    const { claim } = box.call({ action: 'claim', runner: 'r-one', capabilities: [], kinds: ['land'] }, now);
    if (!claim) continue;
    claims += 1;
    box.call({ action: 'release', job: claim.job, runner: 'r-one', token: claim.token, ...release }, now);
  }
  return claims;
}

for (const [name, release] of [['a release with a reason', { reason: 'could not fetch the item' }], ['a release with backoff false, the path that frees a job with no step and no backoff', { reason: 'runner stopped', backoff: false }]]) {
  test(`#7386 clause 1: ${name} is claimed at most 12 times in 3.5 hours, then the job ends as a runaway and its item stays accepted [C7]`, t => {
    const box = landBoard(t);
    const claims = loopFor(box, release);
    assert.equal(claims, 12, `bounded at the cap: ${claims} claims`);
    const count = step => box.board.db.prepare('SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ? AND job_step_name = ?').get(box.job.id, step).n;
    assert.equal(count('claimed'), 12, 'one claimed step per claim, and none after');
    assert.equal(count('runaway'), 1);
    assert.equal(count('released'), 12, 'every hand-back left a step: none was free');
    assert.equal(jobView(box.board.db, box.job.id).step, 'done');
    assert.equal(openLandingJob(box.board.db), null, 'no land job stays open to be re-claimed');
    assert.equal(getItem(box.board, box.id).item_merged_commit ?? null, null);
    const notes = itemThread(box.board, box.id).filter(entry => /released to the lane/u.test(entry.text ?? ''));
    assert.equal(notes.length, 1, JSON.stringify(itemThread(box.board, box.id)));
    const shouts = box.board.db.prepare("SELECT shout_text AS text FROM shout WHERE shout_text LIKE 'runaway land job%'").all();
    assert.equal(shouts.length, 1, 'the coordinator hears once');
  });
}

test('#7386 clause 1: each release backs off longer, so no two claims of one land job are under 30 seconds apart [C7]', t => {
  const box = landBoard(t);
  const at = [];
  for (let now = 1_000; now <= HOUR && at.length < 5; now += 1_000) {
    const { claim } = box.call({ action: 'claim', runner: 'r-one', capabilities: [], kinds: ['land'] }, now);
    if (!claim) continue;
    at.push(now);
    box.call({ action: 'release', job: claim.job, runner: 'r-one', token: claim.token, reason: 'busy', backoff: false }, now);
  }
  assert.equal(at.length, 5);
  const gaps = at.slice(1).map((value, index) => value - at[index]);
  assert.ok(gaps.every((gap, index) => gap >= 30_000 && (index === 0 || gap >= gaps[index - 1])), `gaps grow: ${gaps}`);
});

test('#7386 clause 1: a runner the board lists as draining frees its job at once with backoff false [C7]', t => {
  const box = landBoard(t, { drained: () => ['r-one'] });
  const { claim } = box.call({ action: 'claim', runner: 'r-two', capabilities: [], kinds: ['land'] }, 1_000);
  assert.ok(claim);
  const draining = boardJobQueueCall(box.board, { action: 'release', job: claim.job, runner: 'r-two', token: claim.token, backoff: false }, { mode: 'pull', now: 1_001, drained: () => ['r-two'] });
  assert.equal(draining.released, true);
  assert.ok(box.call({ action: 'claim', runner: 'r-three', capabilities: [], kinds: ['land'] }, 1_002).claim, 'free at once');
});
