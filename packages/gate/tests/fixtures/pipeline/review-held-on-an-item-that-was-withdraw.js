/**
 * A review held on an item that was withdrawn or verified [C7,V15]: a reviewer reserves a submitted item's review
 * job. The invariant: a verdict, a withdraw or a reopen ends that review job in the same transaction (lease freed,
 * step released, done) so a heartbeating reviewer cannot keep it alive (SM5).
 * Fails when verify, withdraw or reopen stops ending the job; passes on main.
 * Run alone with `node packages/gate/tests/fixtures/pipeline/review-held-on-an-item-that-was-withdraw.js`.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  from,
  guardProcesses,
  hopCheck,
  track,
} from './kit.js';

const { createE2eHelpers } = await from('apps/cli/tests/fixtures/e2e.js');
const { makeLandProjectFixtures } = await from('apps/cli/tests/fixtures/land/project.js');
const { withFixtureBoard, joinFixtureSeat } = await from('apps/cli/tests/fixtures/testkit.js');
const { reviewJobId, jobView } = await from('packages/jobs/index.js');
const { getItem } = await from('packages/store/index.js');

const helpers = createE2eHelpers();
const { landProject, itemWorktree, submitItem } = makeLandProjectFixtures(helpers);
guardProcesses({});

/**
 * Submit one item and have a reviewer reserve its review through the real `next --verify`.
 *
 * @param {number} number - The fixture's item number.
 * @returns {{ box: any, entry: any, reviewer: string, read: () => { item: any, job: any } }}
 */
function reservedReview(number) {
  const box = landProject();
  track(box.dir);
  const entry = submitItem(box, itemWorktree(box, number));
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, entry.commit);
  const joined = joinFixtureSeat(box, reviewer, 'api');
  assert.equal(joined.code, 0, joined.err + joined.out);
  const reserved = box.run(reviewer, 'next', '--verify', String(entry.item), '--json');
  assert.equal(reserved.code, 0, reserved.err + reserved.out);
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const read = () => withFixtureBoard(file, board => ({ item: getItem(board, entry.item), job: jobView(board.db, reviewJobId(entry.item)) }));
  const held = read();
  assert.ok(held.item.item_review_by, 'the reviewer holds the item\'s review');
  assert.ok(held.job.leaseOwner, 'the reviewer holds the review job\'s lease');
  return { box, entry, reviewer, read };
}

/**
 * Assert the review job ended with its lease freed.
 *
 * @param {{ job: any }} after
 * @param {string} how
 */
function assertEnded({ job }, how) {
  assert.equal(job.leaseOwner, null, `${how} frees the review job's lease`);
  assert.equal(job.step, 'done', `${how} ends the review job`);
  assert.ok(job.steps.some(step => step.name === 'released'), `${how} records a released step`);
}

test('a verdict ends the item\'s review job in the same transaction [C7,V15]', { timeout: 240_000 }, async () => {
  await hopCheck('review-held-verdict', async () => {
    const { box, entry, reviewer, read } = reservedReview(1);
    const accepted = box.run(reviewer, 'verify', String(entry.item), 'accept', '--no-next', '--note', 'The fixture check passed.', '--json');
    assert.equal(accepted.code, 0, accepted.err + accepted.out);
    const after = read();
    assert.equal(after.item.item_status, 'verified');
    assertEnded(after, 'a verdict');
    return { measured: `verified #${entry.item}; its review job ended with the verdict` };
  });
});

test('a withdraw ends the item\'s review job in the same transaction [C7,V15]', { timeout: 240_000 }, async () => {
  await hopCheck('review-held-withdraw', async () => {
    const { box, entry, read } = reservedReview(1);
    const withdrawn = box.run(box.repo, 'withdraw', String(entry.item), 'not wanted while reviewed', '--json');
    assert.equal(withdrawn.code, 0, withdrawn.err + withdrawn.out);
    const after = read();
    assert.equal(after.item.item_status, 'withdrawn');
    assertEnded(after, 'a withdraw');
    return { measured: `withdrew #${entry.item}; its review job ended with the withdraw` };
  });
});

test('a reopen ends the item\'s review job in the same transaction [C7,V15]', { timeout: 240_000 }, async () => {
  await hopCheck('review-held-reopen', async () => {
    const { box, entry, read } = reservedReview(1);
    const reopened = box.run(box.repo, 'reopen', String(entry.item), '--note', 'reopened while its review was held', '--json');
    assert.equal(reopened.code, 0, reopened.err + reopened.out);
    const after = read();
    assert.notEqual(after.item.item_status, 'submitted');
    assertEnded(after, 'a reopen');
    return { measured: `reopened #${entry.item}; its review job ended with the reopen` };
  });
});
