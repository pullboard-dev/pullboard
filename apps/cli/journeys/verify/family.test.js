/** A builder with no recorded family never deadlocks review under verify.family require [C7,#2964]. */
// fixture-subject: addItem (a store-level unit of next's review reservation over a null-family builder; no kit seam builds a frozen-policy backlog)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

/** The model name the fixture seats register with. */
const FIXTURE_MODEL = ['fixture', 'model'].join('-');

/** A board where an unknown-family builder submitted three items whose frozen rule relaxes at 2 waiting reviews. */
function backlog(t) {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/fixture/coordinator', family: 'human',
    parentDigest: 'a'.repeat(64), model: FIXTURE_MODEL });
  store.register(board, { id: 'core-1', lane: 'core', path: '/fixture/core-1', family: 'openai', parentDigest: 'b'.repeat(64), model: FIXTURE_MODEL });
  store.register(board, { id: 'core-2', lane: 'core', path: '/fixture/core-2', family: 'openai', parentDigest: 'c'.repeat(64), model: FIXTURE_MODEL });
  const ids = [1, 2, 3].map(() => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review fixture', criterion: 'prove it' }));
  now = new Date(now.getTime() + 16 * 60_000);
  for (const id of ids) {
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text: JSON.stringify({ policy: { verify: { family: 'require', familyRelaxAt: 2 } } }), digest: 'fixture-digest' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  }
  // The seat's family is lost after it submitted, as on the audited board where #2853's builder had none recorded.
  board.db.prepare('UPDATE agent SET agent_family=NULL WHERE agent_id=?').run('core-1');
  return { board, ids, options: { agentId: 'core-2', lane: 'core', leaseMs: 3_600_000, policy: 'any', familyPolicy: 'require', familyRelaxAt: 2 } };
}

test('clause 1: a submission whose builder family is unknown is offered to any reviewer once familyRelaxAt is reached [C7,#2964]', t => {
  const { board, ids, options } = backlog(t);
  const offered = store.nextFor(board, { ...options, verify: true });
  assert.ok(ids.includes(offered.item?.item_id), `a reviewer is offered the unknown-family submission: ${offered.reasons?.join('; ')}`);
});

test('clause 2: the relaxation is recorded on the reservation the verdict reads [C7,#2964]', t => {
  const { board, ids, options } = backlog(t);
  const reserved = store.reserveNextReview(board, options).item;
  assert.ok(ids.includes(reserved?.item_id), 'a review is reserved');
  const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='reserve' ORDER BY event_id DESC LIMIT 1").get(reserved.item_id);
  assert.ok(JSON.parse(event.event_detail).familyRelaxation, 'the reservation records the relaxation');
});
