/** @pullboard-test-input source-tree */
/** Review requests bind to the frozen bar without changing older replay [V6,R2,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { openBoard } from '../src/native-board.js';
import { submitFixture } from './board-submit-fixture.js';
import { REVIEW_REQUEST_ENGINE } from '../src/review-request-engine.js';

const criterion = 'The page renders its title. The page renders its footer.';
const clause = 'The page renders its title.';

/** Seed one actual review reservation on a frozen submitted item. */
function fixture(t) {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/request/main' });
  const builder = store.register(board, { lane: 'web', path: '/request/builder', route: 'strong' });
  const reviewer = store.register(board, { lane: 'web', path: '/request/reviewer', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Render the page', criterion,
    check: 'true', route: 'mid', brief: 'Files: web/page.html\nTest: assert the title and footer.' });
  const freeze = () => ({ text: JSON.stringify({ criterion, check: 'true', rows: [],
    policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'request-bar' });
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
  submitFixture(board, id, { agentId: builder, commit: 'a'.repeat(40), tree: 'a'.repeat(40) });
  store.reserveReview(board, id, { agentId: reviewer, lane: 'web', leaseMs: 3_600_000, policy: 'any' });
  return { board, builder, reviewer, id };
}

test('a reviewer request to a builder without a bar clause is refused [V6,R2,H16]', t => {
  const { board, builder, reviewer, id } = fixture(t);
  const message = { from: reviewer, to: builder, item: id, lanes: ['web'], kind: 'request', text: 'Please fix the title.' };
  assert.throws(() => store.shout(board, message), { code: 'BAR_CLAUSE_REQUIRED' });
  assert.throws(() => store.shout(board, { ...message, clause: 'An invented requirement' }), { code: 'BAR_CLAUSE_UNKNOWN' });
  const sent = store.shout(board, { ...message, clause });
  assert.ok(sent > 0, 'a real frozen clause permits the request');
  assert.match(store.getShout(board, sent).shout_text, /Bar: The page renders its title\./u, 'the builder sees the quoted clause');
  assert.ok(store.shout(board, { ...message, kind: 'question' }) > 0, 'ordinary questions do not need a clause');
  board.executionEngineVersion = REVIEW_REQUEST_ENGINE - 1;
  assert.ok(store.shout(board, { ...message, kind: undefined }) > 0, 'older untyped item messages retain their meaning');
  delete board.executionEngineVersion;
  assert.ok(store.shout(board, { ...message, item: undefined, text: `Please fix the title in #${id} before the next review.`, clause: 'true' }) > 0, 'a direct builder request may quote the frozen check');
});

test('a send-back may quote its frozen check [V6,R2,H16]', t => {
  const { board, reviewer, id } = fixture(t);
  const result = store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE',
    note: 'The frozen check failed.', clause: 'true', head: 'a'.repeat(40),
    digest: 'request-bar', policy: 'any' });
  assert.equal(result.clause, 'true');
});
