/** @pullboard-test-input source-cell apps/cli */
/** Coordinator recovery clears a held review reservation through the release command [C7,#11963]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openKitBoard } from '../../tests/fixtures/board.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { document } from '../../tests/fixtures/verify/unsealed.js';
import { submitUnsealed } from '../../tests/fixtures/verify/unsealed.js';

test('cli.journeys-release-review-clear.coordinator-clears-a-held-review-and-reoffers-it: clause 1: coordinator clears a held review reservation and makes it available to next --verify; clause 2: another seat is refused naming the coordinator without writing [C7,#11963]', async (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runIn, box.repo, 'web', 'Review reservation recovery', '--specs', 'G1', '--criterion', 'the page is ready', '--check', 'true', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runIn(box.web, 'claim', String(id), '--json')).code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/page.html', '<main>ready</main>\n', 'feat(web): ready the page [G1]').status, 0);
  await submitUnsealed(box);

  const submitted = document(await box.runIn(box.repo, 'show', String(id), '--json'));
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted.item_commit);
  const joined = joinFixtureSeat(box, reviewer, 'api');
  assert.equal(joined.code, 0, joined.err || joined.out);
  const reserved = document(await box.runIn(reviewer, 'next', '--verify', String(id), '--json'));
  assert.equal(reserved.item.item_id, id);

  const board = openKitBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => store.closeBoard(board));
  const held = store.getItem(board, id);
  const reviewerId = held.item_review_by;
  assert.ok(reviewerId, 'next reserves the review');
  const beforeRefusal = store.events(board);
  const refused = await box.runIn(reviewer, 'release', String(id), '--review', '--json');
  assert.equal(refused.code, 1, refused.err || refused.out);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'COORDINATOR_ONLY');
  assert.match(error.message, /only the coordinator/);
  assert.deepEqual(store.events(board), beforeRefusal, 'the refusal leaves the board event stream unchanged');

  const released = await box.runIn(box.repo, 'release', String(id), '--review', '--json');
  assert.equal(released.code, 0, released.err || released.out);
  assert.match(released.out, /reviewReservationCleared/);
  assert.equal(store.getItem(board, id).item_status, 'submitted');
  assert.equal(store.getItem(board, id).item_review_by, null);
  assert.equal(store.events(board).at(-1).event_kind, 'clear_review_reservation');

  const offeredAgain = document(await box.runIn(reviewer, 'next', '--verify', String(id), '--json'));
  assert.equal(offeredAgain.item.item_id, id);
  assert.equal(store.getItem(board, id).item_review_by, reviewerId);
});
