/** next --verify never reserves a review the seat's family check refused [C7,#2957]. */
// fixture-subject: addItem (a store-level unit of next's review reservation over three seats; no kit seam builds a frozen-policy backlog)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
/** The model name the fixture seats register with. */
const FIXTURE_MODEL = ['fixture', 'model'].join('-');

test('clause 1: next --verify never reserves a review the seat family check refused, for 24 hours [C7,#2957]', t => {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  for (const [id, family, parent] of [['coordinator', 'human', 'a'], ['core-1', 'openai', 'b'], ['core-2', 'openai', 'c']]) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, family,
      parentDigest: parent.repeat(64), model: FIXTURE_MODEL });
  }
  const add = () => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review fixture', criterion: 'prove it' });
  const items = [add(), add(), add()];
  now = new Date(now.getTime() + 16 * 60_000);
  for (const id of items) {
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text: JSON.stringify({ policy: { verify: { family: 'require', familyRelaxAt: 2 } } }), digest: 'fixture-digest' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  }
  const options = { agentId: 'core-2', lane: 'core', leaseMs: 3_600_000, policy: 'any', familyPolicy: 'require', familyRelaxAt: 2 };
  const reserved = store.reserveNextReview(board, options).item;
  assert.ok(items.includes(reserved?.item_id), 'the backlog relaxes the family requirement before any refusal');
  const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='reserve' ORDER BY event_id DESC LIMIT 1").get(reserved.item_id);
  assert.ok(JSON.parse(event.event_detail).familyRelaxation, 'the reservation was relaxed');
  store.release(board, reserved.item_id, 'core-2', 'Same-family review; an independent reviewer family is required.', undefined, 'INELIGIBLE');
  now = new Date(now.getTime() + 60 * 60_000);
  const after = store.nextFor(board, { ...options, verify: true });
  assert.equal(after.item, null, 'no same-family review is offered to the seat whose family check refused one');
  assert.equal(store.reserveNextReview(board, options).item, null, 'and none is reserved');
  assert.ok(after.reasons.some(reason => /family/u.test(reason)), after.reasons.join('\n'));
  now = new Date(now.getTime() + 24 * 60 * 60_000);
  assert.ok(items.includes(store.nextFor(board, { ...options, verify: true }).item?.item_id), 'after 24 hours relaxation applies again');
});
