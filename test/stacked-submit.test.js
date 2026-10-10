/** A candidate cannot carry another item's unverified submission through submit or accept [V17]. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Add a work item through the fixture's real CLI. */
function add(box, lane, title) {
  const result = box.run(box.repo, 'add', lane, title, '--specs', lane === 'web' ? 'G1' : 'G2', '--criterion', title);
  assert.equal(result.code, 0, result.out + result.err);
  return Number(result.out.match(/#(\d+)/u)?.[1]);
}

/** Commit one owned file in a fixture worktree and return its real Git commit. */
function commitFile(box, worktree, name, contents) {
  mkdirSync(join(worktree, name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '.'), { recursive: true });
  writeFileSync(join(worktree, name), contents);
  box.git(worktree, 'add', name);
  box.git(worktree, 'commit', '-q', '-m', `feat(web): ${contents.trim()} [G1]`);
  return box.git(worktree, 'rev-parse', 'HEAD');
}

/** Assert a real CLI refusal names the stacked item and its submitted commit. */
function assertStackRefusal(result, itemId, commit) {
  assert.equal(result.code, 1, result.out + result.err);
  const error = JSON.parse(result.out).error;
  assert.equal(error.code, 'STACKED_ON_UNVERIFIED');
  assert.match(error.message, new RegExp(`#${itemId}\\b`, 'u'));
  assert.ok(error.message.includes(commit), error.message);
  assert.match(error.message, /wait .*accepted/iu);
  assert.match(error.message, /rebuild without/iu);
}

test('[V17] submit refuses a candidate stacked on another item until it is accepted', () => {
  const box = e2e.project('true');
  const first = add(box, 'web', 'First submission');
  assert.equal(box.run(box.web, 'claim', String(first)).code, 0);
  const firstCommit = commitFile(box, box.web, 'web/first.txt', 'first submission');
  assert.equal(box.run(box.web, 'submit', String(first)).code, 0);

  const stacked = add(box, 'web', 'Stacked submission');
  assert.equal(box.run(box.web, 'claim', String(stacked)).code, 0);
  const stackedCommit = commitFile(box, box.web, 'web/stacked.txt', 'stacked submission');
  assertStackRefusal(box.run(box.web, 'submit', String(stacked), '--json'), first, firstCommit);
  assert.equal(JSON.parse(box.run(box.web, 'show', String(stacked), '--json').out).item_status, 'claimed');

  const review = join(box.dir, 'review-first');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, firstCommit);
  assert.match(box.run(review, 'join', 'api').out, /joined as api-1/u);
  const accepted = box.run(review, 'verify', String(first), 'accept', '--note', 'checked the submitted change', '--json');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  const resubmitted = box.run(box.web, 'submit', String(stacked), '--json');
  assert.equal(resubmitted.code, 0, resubmitted.out + resubmitted.err);
  assert.equal(JSON.parse(box.run(box.web, 'show', String(stacked), '--json').out).item_commit, stackedCommit);
});

test('[V17] accept refuses a historical candidate stacked on another item', () => {
  const box = e2e.project('true');
  const first = add(box, 'web', 'Unverified history');
  assert.equal(box.run(box.web, 'claim', String(first)).code, 0);
  const firstCommit = commitFile(box, box.web, 'web/first.txt', 'unverified history');
  assert.equal(box.run(box.web, 'submit', String(first)).code, 0);

  const stacked = add(box, 'web', 'Historical stacked submission');
  assert.equal(box.run(box.web, 'claim', String(stacked)).code, 0);
  const stackedCommit = commitFile(box, box.web, 'web/stacked.txt', 'historical stacked submission');
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    store.submit(board, stacked, {
      agentId: 'web-1',
      commit: stackedCommit,
      tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'),
      policyCommit: JSON.parse(box.run(box.web, 'show', String(stacked), '--json').out).item_claim_head,
    });
  } finally {
    store.closeBoard(board);
  }

  const review = join(box.dir, 'review-stacked');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, stackedCommit);
  assert.match(box.run(review, 'join', 'api').out, /joined as api-1/u);
  assertStackRefusal(box.run(review, 'verify', String(stacked), 'accept', '--note', 'reviewed historical submission', '--json'), first, firstCommit);
  assert.equal(JSON.parse(box.run(review, 'show', String(stacked), '--json').out).item_status, 'submitted');
});

/** Create private history where a claimed item is placed at an unverified submission on trunk. */
function trunkStack(box, { historical = false } = {}) {
  const stacked = add(box, 'coordinator', 'Single-checkout stack');
  assert.equal(box.run(box.repo, 'claim', String(stacked)).code, 0);
  const first = add(box, 'web', 'Unverified trunk commit');
  assert.equal(box.run(box.web, 'claim', String(first)).code, 0);
  const firstCommit = commitFile(box, box.web, 'web/trunk.txt', 'unverified trunk commit');
  assert.equal(box.run(box.web, 'submit', String(first)).code, 0);

  box.git(box.repo, 'merge', '--ff-only', '-q', 'web/one');
  const trunkHead = box.git(box.repo, 'rev-parse', 'HEAD');
  assert.equal(trunkHead, firstCommit);
  if (historical) {
    const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
    try {
      store.submit(board, stacked, {
        agentId: 'coordinator',
        commit: trunkHead,
        tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}'),
        policyCommit: JSON.parse(box.run(box.repo, 'show', String(stacked), '--json').out).item_claim_head,
      });
    } finally {
      store.closeBoard(board);
    }
  }
  return { first, firstCommit, stacked, trunkHead };
}

test('[V17,V1] single-checkout submit allows an unverified head already on trunk', () => {
  const box = e2e.project('true');
  const { first, firstCommit, stacked, trunkHead } = trunkStack(box);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), trunkHead);
  const result = box.run(box.repo, 'submit', String(stacked), '--json');
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(JSON.parse(box.run(box.repo, 'show', String(stacked), '--json').out).item_commit, trunkHead);
  assert.equal(JSON.parse(box.run(box.repo, 'show', String(first), '--json').out).item_status, 'submitted');
});

test('[V17,V1] detached accept allows an unverified head already on trunk', () => {
  const box = e2e.project('true');
  const { first, firstCommit, stacked, trunkHead } = trunkStack(box, { historical: true });
  const review = join(box.dir, 'review-trunk');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, trunkHead);
  assert.match(box.run(review, 'join', 'api').out, /joined as api-1/u);
  const result = box.run(review, 'verify', String(stacked), 'accept', '--note', 'checked detached trunk history', '--json');
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(JSON.parse(box.run(review, 'show', String(stacked), '--json').out).item_status, 'verified');
  assert.equal(JSON.parse(box.run(review, 'show', String(first), '--json').out).item_status, 'submitted');
});

test('[V17] a trunk-merged unverified commit is outside a newer candidate range', () => {
  const box = e2e.project('true');
  const first = add(box, 'web', 'Merged submission');
  assert.equal(box.run(box.web, 'claim', String(first)).code, 0);
  const firstCommit = commitFile(box, box.web, 'web/first.txt', 'merged submission');
  assert.equal(box.run(box.web, 'submit', String(first)).code, 0);
  box.git(box.repo, 'merge', '--ff-only', '-q', 'web/one');

  const stacked = add(box, 'web', 'After trunk merge');
  assert.equal(box.run(box.web, 'claim', String(stacked)).code, 0);
  const stackedCommit = commitFile(box, box.web, 'web/stacked.txt', 'after trunk merge');
  assert.notEqual(stackedCommit, firstCommit);
  const submitted = box.run(box.web, 'submit', String(stacked), '--json');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  assert.equal(JSON.parse(box.run(box.web, 'show', String(stacked), '--json').out).item_commit, stackedCommit);
  assert.equal(JSON.parse(box.run(box.web, 'show', String(first), '--json').out).item_status, 'submitted');
});
