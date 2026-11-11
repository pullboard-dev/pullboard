/** A seat that joined without --family is reviewable once its session derives one [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { fixtureBoard } from '../../../../../apps/cli/tests/fixtures/board.js';
import { submitFixture } from '../../../../../apps/cli/tests/fixtures/board/submit.js';

/** A board with a coordinator, an undeclared builder seat and a reviewer of another vendor. */
function setup(t) {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/fixture/main', family: 'human', session: 'sess-coord', model: 'm' });
  store.register(board, { id: 'core-1', lane: 'core', path: '/fixture/core-1', session: 'sess-build', model: 'm' });
  store.register(board, { id: 'core-2', lane: 'core', path: '/fixture/core-2', family: 'openai', session: 'sess-review', model: 'm' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Family fixture', criterion: 'prove it' });
  now = new Date(now.getTime() + 16 * 60_000);
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze: () => ({ text: '{}', digest: 'fixture-digest' }) });
  return { board, id };
}
const column = (board, seat) => board.db.prepare('SELECT agent_family AS f FROM agent WHERE agent_id=?').get(seat).f;

test('submit records the derived family of a seat whose own column is NULL [C7]', t => {
  const { board, id } = setup(t);
  // A peer of the same session declares the vendor; the builder's own column stays NULL.
  store.register(board, { id: 'core-3', lane: 'core', path: '/fixture/core-3', family: 'anthropic', session: 'sess-build', model: 'm' });
  assert.equal(column(board, 'core-1'), null);
  submitFixture(board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
  assert.equal(store.getItem(board, id).item_builder_family, 'anthropic');
});

test('review admission uses the builder seat current family when none was recorded [C7]', t => {
  const { board, id } = setup(t);
  submitFixture(board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
  assert.equal(store.getItem(board, id).item_builder_family, null, 'nothing was declared at submit');
  store.register(board, { id: 'core-1', lane: 'core', path: '/fixture/core-1', family: 'anthropic', model: 'm' });
  const options = { agentId: 'core-2', leaseMs: 3_600_000, policy: 'any', familyPolicy: 'require' };
  assert.doesNotThrow(() => store.reserveReview(board, id, options));
  assert.equal(store.getItem(board, id).item_review_by, 'core-2');
});

test('join --family on a seat with a NULL column writes it though its session derived it [C7]', t => {
  const { board } = setup(t);
  store.register(board, { id: 'core-3', lane: 'core', path: '/fixture/core-3', family: 'anthropic', session: 'sess-build', model: 'm' });
  assert.equal(column(board, 'core-1'), null);
  store.register(board, { id: 'core-1', lane: 'core', path: '/fixture/core-1', family: 'anthropic', model: 'm' });
  assert.equal(column(board, 'core-1'), 'anthropic');
});
