/** Historical submitted heads cannot bypass review after a sibling resubmission [V17,V1]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import {
  FIXTURE_MODEL,
  FIXTURE_MODEL_EARLIER,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
// The shared cleanup waits up to 30 s for a detached writer; a private 2 s loop failed with ENOTEMPTY on a loaded runner [C7,#2817,#3192].
after(e2e.cleanup);

/** Add a real board item through the coordinator CLI. */
function add(box, title) {
  const result = fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1', '--criterion', title, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return Number(JSON.parse(result.out).item.item_id);
}

/** Join a real worktree under the current admission rules and require the seat to be in the named lane. */
function joinSeat(box, root, lane, options) {
  const joined = joinFixtureSeat(box, root, lane, options);
  assert.equal(joined.code, 0, joined.out + joined.err);
  assert.match(JSON.parse(joined.out).agent, new RegExp(`^${lane}-`, 'u'));
}

/** Create and commit one distinct path in the supplied real worktree. */
function commitFile(box, cwd, path, contents) {
  mkdirSync(join(cwd, path, '..'), { recursive: true });
  writeFileSync(join(cwd, path), contents);
  box.git(cwd, 'add', path);
  box.git(cwd, 'commit', '-q', '-m', `feat(web): ${contents.trim().toLowerCase()} [G1]`);
  return box.git(cwd, 'rev-parse', 'HEAD');
}

/** Require the real submit command to identify the historical rejected submission. */
function assertBlockedByHistoricalHead(result, itemId, oldHead) {
  assert.equal(result.code, 1, result.out + result.err);
  const refusal = JSON.parse(result.out).error;
  assert.equal(refusal.code, 'STACKED_ON_UNVERIFIED');
  assert.match(refusal.message, new RegExp(`#${itemId}\\b`, 'u'));
  assert.ok(refusal.message.includes(oldHead), refusal.message);
  assert.match(refusal.message, /wait .*accepted/iu);
  assert.match(refusal.message, /rebuild without/iu);
}

/**
 * Make A's old submission, B's candidate based on that old head, then A's sibling resubmission.
 * B and A-retry use separate real worktrees so A's newer submission cannot enter B's history.
 */
function submittedSiblingHistory() {
  const box = e2e.project('true');
  const itemA = add(box, 'A old submitted head');
  assert.equal(box.run(box.web, 'claim', String(itemA)).code, 0);
  const oldHead = commitFile(box, box.web, 'web/a-old.txt', 'A old submitted head');
  assert.equal(box.run(box.web, 'submit', String(itemA)).code, 0);

  const itemB = add(box, 'B based on A old head');
  const bWorktree = join(box.dir, 'web-b-from-old-a');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/b-candidate', bWorktree, oldHead);
  joinSeat(box, bWorktree, 'web', { model: FIXTURE_MODEL });
  const claimedB = box.run(bWorktree, 'claim', String(itemB));
  assert.equal(claimedB.code, 0, claimedB.out + claimedB.err);
  const bHead = commitFile(box, bWorktree, 'web/b-candidate.txt', 'B candidate based on old A');

  const oldReview = join(box.dir, 'review-old-a');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', oldReview, oldHead);
  joinSeat(box, oldReview, 'api', { model: FIXTURE_MODEL_EARLIER });
  const rejected = box.run(oldReview, 'verify', String(itemA), 'reject', '--reason', 'TEST_FAILURE', '--clause', 'A old submitted head', '--note', 'revise A before acceptance', '--json');
  assert.equal(rejected.code, 0, rejected.out + rejected.err);

  const base = box.git(box.repo, 'rev-parse', `${oldHead}^`);
  const retryWorktree = join(box.dir, 'web-a-sibling-retry');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/a-retry', retryWorktree, base);
  joinSeat(box, retryWorktree, 'web', { model: FIXTURE_MODEL });
  assert.equal(box.run(retryWorktree, 'claim', String(itemA)).code, 0);
  const latestAHead = commitFile(box, retryWorktree, 'web/a-new.txt', 'A newer sibling submission');
  assert.notEqual(latestAHead, oldHead);
  assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', oldHead, latestAHead).status, 1,
    'A newer resubmission is a sibling, not a descendant of A old head');
  assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', latestAHead, bHead).status, 1,
    'B does not contain A newer head');
  assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', oldHead, 'main').status, 1,
    'the historical A submission is not reachable from the trunk exemption');
  assert.equal(box.run(retryWorktree, 'submit', String(itemA)).code, 0);

  return { box, itemA, itemB, oldHead, latestAHead, bHead, bWorktree };
}

test('[V17,V1] an old submitted head remains stacked on another item after a sibling resubmission', () => {
  const { box, itemA, itemB, oldHead, latestAHead, bHead, bWorktree } = submittedSiblingHistory();
  assert.equal(box.git(bWorktree, 'rev-parse', 'HEAD'), bHead);
  assertBlockedByHistoricalHead(box.run(bWorktree, 'submit', String(itemB), '--json'), itemA, oldHead);
  const a = JSON.parse(box.run(bWorktree, 'show', String(itemA), '--json').out);
  assert.equal(a.item_status, 'submitted');
  assert.equal(a.item_commit, latestAHead);
  assert.equal(JSON.parse(box.run(bWorktree, 'show', String(itemB), '--json').out).item_status, 'claimed');
});

test('[V17,V1] accepting the latest sibling submission clears every historical stack blocker', () => {
  const { box, itemA, itemB, oldHead, latestAHead, bHead, bWorktree } = submittedSiblingHistory();
  const latestReview = join(box.dir, 'review-latest-a');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', latestReview, latestAHead);
  joinSeat(box, latestReview, 'api', { model: FIXTURE_MODEL_EARLIER });
  const accepted = box.run(latestReview, 'verify', String(itemA), 'accept', '--note', 'accepted A latest sibling head', '--json');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);

  assert.equal(box.git(bWorktree, 'rev-parse', 'HEAD'), bHead);
  const submitted = box.run(bWorktree, 'submit', String(itemB), '--json');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  assert.equal(JSON.parse(box.run(bWorktree, 'show', String(itemB), '--json').out).item_commit, bHead);
  assert.notEqual(oldHead, latestAHead);
});
