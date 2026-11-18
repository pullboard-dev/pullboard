/** A require-family review widens through the real next --verify after the idle window and records why [V1,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../../packages/store/index.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { cli } from '../../../tests/fixtures/next/take.js';
import { fixture } from '../../../tests/fixtures/next/take.js';

/** The frozen rule: same-family review is allowed once two submissions lack an available other-family reviewer. */
const FROZEN = JSON.stringify({ policy: { verify: { family: 'require', familyRelaxAt: 2 } } });

/** File an item, claim it as the builder under the frozen require rule and submit it at the builder's head. */
function submitted(box, title) {
  const id = box.add(title);
  const seat = box.seats.builder;
  store.claim(box.board, id, { agentId: seat.id, lane: seat.lane, leaseMs: 3_600_000,
    freeze: () => ({ text: FROZEN, digest: createHash('sha256').update(FROZEN).digest('hex') }) });
  const head = box.git(seat.path, 'rev-parse', 'HEAD');
  submitFixture(box.board, id, { agentId: seat.id, commit: head, tree: box.git(box.root, 'rev-parse', `${head}^{tree}`) });
  return id;
}

test('cli.journeys-show-review-tier.with-verify-family-require-and-no: clause 1: with verify.family require and no live eligible seat for 20 minutes, the real next --verify offers the item to a seat of another session and the verdict record says the family rule was widened and why [V1,H16]', async t => {
  const box = await fixture(t, { family: 'require' });
  const first = submitted(box, 'Review waits on a same-family seat');
  const second = submitted(box, 'A second review waits too');
  const reviewer = box.seats.sameFamily;

  const early = await cli(box, reviewer.path, ['next', '--verify']);
  assert.equal(early.code, 1, early.out + early.err);
  assert.equal(early.document.error.code, 'NOTHING_FREE', 'an other-family reviewer is still live, so the rule holds');
  assert.match(early.document.error.message, /SAME_FAMILY/u);

  box.advance(20 * 60_000);
  const late = await cli(box, reviewer.path, ['next', '--verify']);
  assert.equal(late.code, 0, late.out + late.err);
  const offered = late.document.item.item_id;
  assert.ok([first, second].includes(offered), `offered #${offered}`);
  assert.equal(store.getItem(box.board, offered).item_review_by, reviewer.id);

  const item = store.getItem(box.board, offered);
  store.verify(box.board, offered, { agentId: reviewer.id, decision: 'ACCEPT', note: 'inspected the change',
    head: item.item_commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'require' });
  const verdict = box.board.db.prepare('SELECT verdict_note FROM verdict WHERE item_id=?').get(offered);
  assert.match(verdict.verdict_note, /review family relaxed at reservation: 2 waiting, threshold 2/u);
});

test('cli.journeys-show-review-tier.an-eligible-reviewer-that-is-joined: clause 1: an eligible reviewer that is joined, live and busy holding another review keeps the item unwidened under the real next --verify [V1,H16]', async t => {
  const box = await fixture(t, { family: 'require' });
  const held = submitted(box, 'The live reviewer holds this review');
  const waiting = [submitted(box, 'Waits behind a busy reviewer'), submitted(box, 'A second review waits too')];
  const busy = box.seats.outside;
  const taken = await cli(box, busy.path, ['next', '--verify']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, held, 'the other-family reviewer takes the first review');

  box.advance(20 * 60_000);
  heartbeatSeat(box.board, busy.id);
  const reviewer = box.seats.sameFamily;
  const late = await cli(box, reviewer.path, ['next', '--verify']);
  assert.equal(late.code, 1, `the busy live reviewer is still eligible, so the rule holds: ${late.out}${late.err}`);
  assert.equal(late.document.error.code, 'NOTHING_FREE');
  for (const id of waiting) assert.equal(store.getItem(box.board, id).item_review_by, null, `#${id} stays unreserved`);
});

test('cli.journeys-show-review-tier.an-eligible-reviewer-that-is-joined-2: clause 2: an eligible reviewer that is joined, live and idle for over 15 minutes keeps the item unwidened [V1,H16]', async t => {
  const box = await fixture(t, { family: 'require' });
  const first = submitted(box, 'Waits for a live idle reviewer');
  const second = submitted(box, 'A second review waits too');
  const idle = box.seats.outside;

  box.advance(20 * 60_000);
  heartbeatSeat(box.board, idle.id);
  const reviewer = box.seats.sameFamily;
  const late = await cli(box, reviewer.path, ['next', '--verify']);
  assert.equal(late.code, 1, `the idle reviewer has a live heartbeat, so the rule holds: ${late.out}${late.err}`);
  assert.equal(late.document.error.code, 'NOTHING_FREE');
  for (const id of [first, second]) assert.equal(store.getItem(box.board, id).item_review_by, null, `#${id} stays unreserved`);
});
