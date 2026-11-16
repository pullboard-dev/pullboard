/** The pre-push gate re-offers a shard whose runner lapsed or posted an infrastructure failure once, behind push.rerunFailedShardOnce [C7,#9274]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHARD_JOB_KIND } from '../../../../packages/api/index.js';
import { claimJob } from '../../../../packages/api/index.js';
import { endJobs } from '../../../../packages/api/index.js';
import { jobViews } from '../../../../packages/api/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { postReceipt } from '../../../../packages/api/index.js';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { awaitPushShards } from '../../src/io/hook/push.js';

const green = { status: 0, gate: { green: true, phases: [] } };
const infraRed = { status: 1, gate: { green: false, phases: [], analysis: { infra: 'runner disk full' } } };

/** A board with one offered shard, the clock, and the reoffer the push gate wires (end the job, offer `<job>:again` avoiding the runner). */
function setup(t) {
  const { db } = cellBoard(t, ':memory:');
  const clock = { at: 1_000_000 };
  const jobs = ['push:abc:tag:shard:1'];
  offerJob(db, { id: jobs[0], kind: SHARD_JOB_KIND, priority: 'gate', now: clock.at });
  const offers = [];
  const reoffer = (board, job, runner) => {
    endJobs(board.db, [job], { now: clock.at });
    offers.push({ job, runner });
    return offerJob(board.db, { id: `${job}:again`, kind: SHARD_JOB_KIND, priority: 'gate', avoid: [runner], now: clock.at }).id;
  };
  const on = work => work({ db });
  return { db, clock, jobs, offers, reoffer, on };
}

test('clause 1: with push.rerunFailedShardOnce on, a shard whose runner lapsed is re-offered once with that runner on its avoid list [C7,#9274]', async t => {
  const { db, clock, jobs, offers, reoffer, on } = setup(t);
  const first = claimJob(db, { runner: 'r1', now: clock.at });
  let polls = 0;
  const wait = async () => {
    polls += 1;
    assert.ok(polls < 12, 'never settled');
    if (polls === 1) clock.at = first.leaseUntil + 1;
    if (polls === 3) {
      assert.equal(claimJob(db, { runner: 'r1', avoidRunners: true, now: clock.at }), null, 'the lapsed runner is not offered the rerun');
      const second = claimJob(db, { runner: 'r2', avoidRunners: true, now: clock.at });
      assert.equal(second.job, 'push:abc:tag:shard:1:again');
      postReceipt(db, { job: second.job, runner: 'r2', token: second.token, receipt: green, now: clock.at });
    }
  };
  const settled = await awaitPushShards({}, jobs, { read: on, write: on, now: () => clock.at, wait, pollMs: 0, limitMs: 60_000_000, reoffer, rerun: true });
  assert.deepEqual(offers, [{ job: 'push:abc:tag:shard:1', runner: 'r1' }]);
  assert.deepEqual(jobs, ['push:abc:tag:shard:1:again'], 'the gate now waits on the re-offered job');
  assert.equal(settled[0].posted.receipt.status, 0);
  assert.equal(jobViews(db, ['push:abc:tag:shard:1'])[0].step, 'done');
});

test('clause 1: a shard that posts an infrastructure failure is re-offered once the same way [C7,#9274]', async t => {
  const { db, clock, jobs, offers, reoffer, on } = setup(t);
  const first = claimJob(db, { runner: 'r1', now: clock.at });
  postReceipt(db, { job: first.job, runner: 'r1', token: first.token, receipt: infraRed, now: clock.at });
  let polls = 0;
  const wait = async () => {
    polls += 1;
    assert.ok(polls < 12, 'never settled');
    const second = claimJob(db, { runner: 'r2', avoidRunners: true, now: clock.at });
    postReceipt(db, { job: second.job, runner: 'r2', token: second.token, receipt: green, now: clock.at });
  };
  const settled = await awaitPushShards({}, jobs, { read: on, write: on, now: () => clock.at, wait, pollMs: 0, limitMs: 60_000_000, reoffer, rerun: true });
  assert.deepEqual(offers.map(row => row.runner), ['r1']);
  assert.equal(settled[0].posted.receipt.status, 0);
});

test('clause 2: a second lapse of the same shard refuses and offers no third job; a second infrastructure failure ends it as failed [C7,#9274]', async t => {
  const { db, clock, jobs, offers, reoffer, on } = setup(t);
  let held = claimJob(db, { runner: 'r1', now: clock.at });
  let polls = 0;
  const wait = async () => {
    polls += 1;
    assert.ok(polls < 12, 'never settled');
    clock.at = held.leaseUntil + 1;
    if (polls === 2) held = claimJob(db, { runner: 'r2', avoidRunners: true, now: clock.at });
  };
  const result = await awaitPushShards({}, jobs, { read: on, write: on, now: () => clock.at, wait, pollMs: 0, limitMs: 60_000_000, reoffer, rerun: true });
  assert.match(result.refused, /lapsed on runner r2 after it was re-offered once/u);
  assert.equal(offers.length, 1, 'only one re-offer was made');

  const again = setup(t);
  const claim = claimJob(again.db, { runner: 'r1', now: again.clock.at });
  postReceipt(again.db, { job: claim.job, runner: 'r1', token: claim.token, receipt: infraRed, now: again.clock.at });
  let seen = 0;
  const settled = await awaitPushShards({}, again.jobs, { read: again.on, write: again.on, now: () => again.clock.at, pollMs: 0, limitMs: 60_000_000, reoffer: again.reoffer, rerun: true,
    wait: async () => {
      seen += 1;
      assert.ok(seen < 12, 'never settled');
      const second = claimJob(again.db, { runner: 'r2', avoidRunners: true, now: again.clock.at });
      if (second) postReceipt(again.db, { job: second.job, runner: 'r2', token: second.token, receipt: infraRed, now: again.clock.at });
    } });
  assert.equal(again.offers.length, 1, 'no third offer');
  assert.equal(settled[0].posted.receipt.status, 1, 'the second failure ends the shard red');
});

test('clause 2: with the setting off nothing is re-offered, and the setting is described [C7,#9274]', async t => {
  const { db, clock, jobs, reoffer, on } = setup(t);
  const first = claimJob(db, { runner: 'r1', now: clock.at });
  postReceipt(db, { job: first.job, runner: 'r1', token: first.token, receipt: infraRed, now: clock.at });
  const forbidden = () => { throw new Error('re-offered with the setting off'); };
  const settled = await awaitPushShards({}, jobs, { read: on, write: on, now: () => clock.at, wait: async () => {}, pollMs: 0, limitMs: 60_000_000, reoffer: forbidden, rerun: false });
  assert.equal(settled[0].posted.receipt.status, 1);
  assert.equal(typeof reoffer, 'function');
  const { describeSetting } = await import('../../../../packages/config/index.js');
  assert.ok(describeSetting('push.rerunFailedShardOnce'), 'push.rerunFailedShardOnce has a description');
});
