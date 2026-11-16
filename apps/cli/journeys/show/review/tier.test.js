/** A require-family review widens through the real next --verify after the idle window and records why [V1,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
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

test('clause 1: with verify.family require and no live eligible seat for 20 minutes, the real next --verify offers the item to a seat of another session and the verdict record says the family rule was widened and why [V1,H16]', async t => {
  const box = await fixture(t, { family: 'require' });
  const first = submitted(box, 'Review waits on a same-family seat');
  const second = submitted(box, 'A second review waits too');
  const reviewer = box.seats.sameFamily;

  const early = await cli(box, reviewer.path, ['next', '--verify']);
  assert.equal(early.code, 0, early.out + early.err);
  assert.equal(early.document.item, null, 'an other-family reviewer is still live, so the rule holds');

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
