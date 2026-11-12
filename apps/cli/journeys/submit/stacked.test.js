/** A candidate cannot carry another item's unverified submission through submit or accept [V17]. */
import { submitFixture } from "../../tests/fixtures/board/submit.js";
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from "../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../packages/store/tests/fixtures/cell.js";
import { createE2eHelpers } from "../../tests/fixtures/e2e.js";
import { FIXTURE_MODEL } from "../../tests/fixtures/e2e.js";
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();

/**
 * Whether any fixture repository still has a queued submit worker at work: its job folder still holds the worker's
 * source checkout, or the tool snapshot its request names. Each real submit here queues one such detached worker.
 */
function submitWorkersBusy() {
  return e2e.sandboxes.some(dir => {
    const jobs = join(dir, 'repo', '.git', 'pullboard', 'submit-handoffs');
    if (!existsSync(jobs)) return false;
    return readdirSync(jobs).some(job => {
      const request = join(jobs, job, 'request.json');
      let tools = null;
      try { tools = JSON.parse(readFileSync(request, 'utf8')).tools ?? null; } catch { /* A request still being written names nothing yet. */ }
      return existsSync(join(jobs, job, 'source')) || Boolean(tools && existsSync(tools));
    });
  });
}

/**
 * Let the queued submit workers finish, then delete the fixtures asynchronously. Why: a synchronous rmSync retrying
 * ENOTEMPTY while a worker still writes its job folder blocked the main thread past the 30 s file-exit timeout, and
 * the runner killed the file with a live Socket handle [C7].
 */
after(async () => {
  try {
    await e2e.waitFor(() => !submitWorkersBusy(), 'queued submit worker cleanup', 25_000); // budget: hang ceiling for owned worker cleanup; no elapsed-time assertion.
  } catch { /* A worker still running past the ceiling is removed with its fixture below. */ }
  await Promise.all(e2e.sandboxes.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

/** Add a work item through the fixture's real CLI. */
async function add(box, lane, title) {
  const result = (await fixtureAdd(box.runLocal, box.repo, lane, title, '--specs', lane === 'web' ? 'G1' : 'G2', '--criterion', title));
  assert.equal(result.code, 0, result.out + result.err);
  return Number(result.out.match(/#(\d+)/u)?.[1]);
}

/** Commit one owned file in a fixture worktree and return its real Git commit; a trailer cites the item the commit also serves. */
function commitFile(box, worktree, name, contents, trailer = '') {
  mkdirSync(join(worktree, name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '.'), { recursive: true });
  writeFileSync(join(worktree, name), contents);
  box.git(worktree, 'add', name);
  box.git(worktree, 'commit', '-q', '-m', `feat(web): ${contents.trim()} [G1]`, ...(trailer ? ['-m', trailer] : []));
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

test('clause 1, clause 2: [V17] submit refuses a candidate stacked on another item until it is accepted', async () => {
  const box = e2e.project('true');
  const first = (await add(box, 'web', 'First submission'));
  assert.equal((await box.runLocal(box.web, 'claim', String(first))).code, 0);
  const firstCommit = commitFile(box, box.web, 'web/first.txt', 'first submission');
  assert.equal((await box.runLocal(box.web, 'submit', String(first))).code, 0);

  const stacked = (await add(box, 'web', 'Stacked submission'));
  assert.equal((await box.runLocal(box.web, 'claim', String(stacked))).code, 0);
  const stackedCommit = commitFile(box, box.web, 'web/stacked.txt', 'stacked submission');
  assertStackRefusal((await box.runLocal(box.web, 'submit', String(stacked), '--json')), first, firstCommit);
  assert.equal(JSON.parse((await box.runLocal(box.web, 'show', String(stacked), '--json')).out).item_status, 'claimed');

  const review = join(box.dir, 'review-first');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, firstCommit);
  assert.match((await fixtureJoin(box.runLocal, review, 'api', '--model', FIXTURE_MODEL, '--route', 'strong')).out, /joined as api-1/u);
  const accepted = (await box.runLocal(review, 'verify', String(first), 'accept', '--note', 'checked the submitted change', '--json'));
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  const resubmitted = (await box.runLocal(box.web, 'submit', String(stacked), '--json'));
  assert.equal(resubmitted.code, 0, resubmitted.out + resubmitted.err);
  assert.equal(JSON.parse((await box.runLocal(box.web, 'show', String(stacked), '--json')).out).item_commit, stackedCommit);
});

test('[V17] accept refuses a historical candidate stacked on another item', async () => {
  const box = e2e.project('true');
  const first = (await add(box, 'web', 'Unverified history'));
  assert.equal((await box.runLocal(box.web, 'claim', String(first))).code, 0);
  const firstCommit = commitFile(box, box.web, 'web/first.txt', 'unverified history');
  assert.equal((await box.runLocal(box.web, 'submit', String(first))).code, 0);

  const stacked = (await add(box, 'web', 'Historical stacked submission'));
  assert.equal((await box.runLocal(box.web, 'claim', String(stacked))).code, 0);
  const stackedCommit = commitFile(box, box.web, 'web/stacked.txt', 'historical stacked submission');
  // @pullboard-board-file journey: read the board file the real CLI submission wrote
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    submitFixture(board, stacked, {
      agentId: 'web-1',
      commit: stackedCommit,
      tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'),
      policyCommit: box.git(box.repo, 'rev-parse', 'main'),
    });
  } finally {
    store.closeBoard(board);
  }

  const review = join(box.dir, 'review-stacked');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, stackedCommit);
  assert.match((await fixtureJoin(box.runLocal, review, 'api', '--model', FIXTURE_MODEL, '--route', 'strong')).out, /joined as api-1/u);
  assertStackRefusal((await box.runLocal(review, 'verify', String(stacked), 'accept', '--note', 'reviewed historical submission', '--json')), first, firstCommit);
  assert.equal(JSON.parse((await box.runLocal(review, 'show', String(stacked), '--json')).out).item_status, 'submitted');
});

/**
 * Create private history where a claimed item is placed at an unverified submission on trunk. Historical placement
 * records the unverified commit itself; a live single-checkout submit gets its own commit on trunk above it [V17,V1].
 */
async function trunkStack(box, { historical = false } = {}) {
  const stacked = (await add(box, 'coordinator', 'Single-checkout stack'));
  assert.equal((await box.runLocal(box.repo, 'claim', String(stacked))).code, 0);
  const first = (await add(box, 'web', 'Unverified trunk commit'));
  assert.equal((await box.runLocal(box.web, 'claim', String(first))).code, 0);
  const firstCommit = commitFile(box, box.web, 'web/trunk.txt', 'unverified trunk commit');
  assert.equal((await box.runLocal(box.web, 'submit', String(first))).code, 0);

  box.git(box.repo, 'merge', '--ff-only', '-q', 'web/one');
  const trunkHead = box.git(box.repo, 'rev-parse', 'HEAD');
  assert.equal(trunkHead, firstCommit);
  if (historical) {
    // @pullboard-board-file journey: read the board file the real CLI submission wrote
    const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
    try {
      submitFixture(board, stacked, {
        agentId: 'coordinator',
        commit: trunkHead,
        tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}'),
        policyCommit: JSON.parse((await box.runLocal(box.repo, 'show', String(stacked), '--json')).out).item_claim_head,
      });
    } finally {
      store.closeBoard(board);
    }
    return { first, firstCommit, stacked, trunkHead };
  }
  // Since #2608 a submit whose head is main itself is EMPTY_SUBMIT unless that head cites the item, so the single
  // checkout commits the stacked item's own change on trunk above the unverified commit and submits that head.
  return { first, firstCommit, stacked, trunkHead: commitFile(box, box.repo, 'web/single-checkout.txt', 'single-checkout stacked change') };
}

test('[V17,V1] single-checkout submit allows an unverified head already on trunk', async () => {
  const box = e2e.project('true');
  const { first, firstCommit, stacked, trunkHead } = (await trunkStack(box));
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), trunkHead);
  const result = (await box.runLocal(box.repo, 'submit', String(stacked), '--json'));
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', String(stacked), '--json')).out).item_commit, trunkHead);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', String(first), '--json')).out).item_status, 'submitted');
});

test('[V17,V1] detached accept allows an unverified head already on trunk', async () => {
  const box = e2e.project('true');
  const { first, firstCommit, stacked, trunkHead } = (await trunkStack(box, { historical: true }));
  const review = join(box.dir, 'review-trunk');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, trunkHead);
  assert.match((await fixtureJoin(box.runLocal, review, 'api', '--model', FIXTURE_MODEL, '--route', 'strong')).out, /joined as api-1/u);
  const result = (await box.runLocal(review, 'verify', String(stacked), 'accept', '--note', 'checked detached trunk history', '--json'));
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(JSON.parse((await box.runLocal(review, 'show', String(stacked), '--json')).out).item_status, 'verified');
  assert.equal(JSON.parse((await box.runLocal(review, 'show', String(first), '--json')).out).item_status, 'submitted');
});

test('[V17] a trunk-merged unverified commit is outside a newer candidate range', async () => {
  const box = e2e.project('true');
  const first = (await add(box, 'web', 'Merged submission'));
  assert.equal((await box.runLocal(box.web, 'claim', String(first))).code, 0);
  const firstCommit = commitFile(box, box.web, 'web/first.txt', 'merged submission');
  assert.equal((await box.runLocal(box.web, 'submit', String(first))).code, 0);
  box.git(box.repo, 'merge', '--ff-only', '-q', 'web/one');

  const stacked = (await add(box, 'web', 'After trunk merge'));
  assert.equal((await box.runLocal(box.web, 'claim', String(stacked))).code, 0);
  const stackedCommit = commitFile(box, box.web, 'web/stacked.txt', 'after trunk merge');
  assert.notEqual(stackedCommit, firstCommit);
  const submitted = (await box.runLocal(box.web, 'submit', String(stacked), '--json'));
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  assert.equal(JSON.parse((await box.runLocal(box.web, 'show', String(stacked), '--json')).out).item_commit, stackedCommit);
  assert.equal(JSON.parse((await box.runLocal(box.web, 'show', String(first), '--json')).out).item_status, 'submitted');
});
