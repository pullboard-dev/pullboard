/** A boardless clone's next, claim, fact, release, submit and verify move a served board through POST /moves [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkOutSubmitted } from '../../../fixtures/api.js';
import { commitWork } from '../../../fixtures/api.js';
import { FIXTURE_MODEL } from '../../../fixtures/testkit.js';
import { cloneBoard } from '../../../fixtures/api/remote-moves.js';
import { moved } from '../../../fixtures/api/remote-moves.js';
import { served } from '../../../fixtures/api/remote-moves.js';
import { settledRow } from '../../../fixtures/api/remote-moves.js';
import { sharedBody } from '../../../fixtures/api/remote-moves.js';

test('cli.io-remote-moves.next-claim-fact-and-release-from-a: next, claim, fact and release from a boardless clone change the served board [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board and eight CLI calls, not a throughput claim.
sharedBody(async (seats) => {
  // This case holds its claim to the end on a seat of its own, so the shared board's builder stays free for the next cases (a seat holds one item) [P7].
  const mover = await served(seats.box, seats.box.root, 'worktree', 'app', '--model', FIXTURE_MODEL, '--family', 'codex');
  const id = await seats.add('Remote movable item');
  const offered = await moved(seats, mover, 'next');
  assert.equal(offered.item.item_id, id, 'next claimed the open item on the served board');
  assert.equal((await seats.row(id)).status, 'claimed');
  await moved(seats, mover, 'fact', String(id), 'note', 'written from another host');
  const { events } = (await seats.box.call(`${seats.box.path}/events`)).document;
  assert.ok(events.some((event) => event.event_kind === 'fact' && JSON.stringify(event).includes('written from another host')), 'the fact reached the served board');
  await moved(seats, mover, 'release', String(id), '--reason', 'OTHER', '--note', 'handing it back');
  assert.equal((await seats.row(id)).status, 'open', 'release reopened the item on the served board');
  const text = await seats.run(mover, 'claim', String(id));
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, new RegExp(`^claimed #${id}\\b.* via http://`, 'mu'));
  assert.equal((await seats.row(id)).status, 'claimed', 'claim took the item on the served board');
  assert.equal(cloneBoard(seats.clone), false, 'no move opened a local board');
  await moved(seats, mover, 'release', String(id), '--reason', 'OTHER', '--note', 'the next case claims its own item');
}));

test('cli.io-remote-moves.submit-and-verify-post-through-moves-and: submit and verify post through /moves and print the served board\'s result [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board, one submit handoff and six CLI calls, not a throughput claim.
sharedBody(async (seats) => {
  const id = await seats.add('Remote reviewed item');
  await moved(seats, seats.builder, 'claim', String(id));
  commitWork(seats.box, seats.builder, id);
  const submitted = await seats.run(seats.builder, 'submit', String(id));
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  assert.match(submitted.stdout, new RegExp(`^submitted #${id}\\b.* via http://`, 'mu'));
  assert.equal((await settledRow(seats, id)).status, 'submitted', 'the host runner posted the pulled gate receipt');
  checkOutSubmitted(seats.box, seats.builder, seats.verifier);
  const reserved = await moved(seats, seats.verifier, 'next', '--verify');
  assert.equal(reserved.item.item_id, id, 'next --verify reserved the review on the served board');
  const verdict = await moved(seats, seats.verifier, 'verify', String(id), 'accept', '--reason', 'CRITERION_MET', '--note', 'read the diff by URL');
  assert.equal(verdict.item?.item_id ?? verdict.item_id ?? id, id);
  assert.equal((await seats.row(id)).status, 'verified', 'the verdict reached the served board');
  assert.equal(cloneBoard(seats.clone), false, 'no move opened a local board');
}));
