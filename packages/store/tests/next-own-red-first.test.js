/** next hands a seat its own red-gated item first, and a red item nobody holds before any never-built item [C7,#4014]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../index.js';
import { openKitBoard } from '../../../apps/cli/tests/fixtures/testkit.js';
import { recordSubmitHandoff } from '../../jobs/index.js';

// fixture-subject: addItem (a store unit test of next over seeded items; the board is opened through the kit)
const COMMIT = 'c'.repeat(40);

/** A board with a builder seat, a second seat, and two open items of one lane, the second to be built first and left red. */
function fixture(t) {
  const board = openKitBoard(':memory:', { now: () => new Date('2026-11-09T08:00:00.000Z') });
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const builder = store.register(board, { lane: 'core', path: '/builder', route: 'mid' });
  const other = store.register(board, { lane: 'core', path: '/other', route: 'mid' });
  const add = (title, file) => store.addItem(board, { by: 'coordinator', lane: 'core', title, criterion: 'prove', specIds: ['C7'], route: 'mid', check: 'true', brief: `Files: src/${file}\nTest: proves it` });
  const fresh = add('Never built', 'fresh.js');
  const red = add('Built and red', 'red.js');
  return { board, builder, other, fresh, red };
}

/** Record that `agent` built item `id` at COMMIT and its gate went red there. */
function leaveRed(board, id, agent, state = 'red') {
  board.db.prepare('UPDATE item SET item_built_by = ?, item_commit = ? WHERE item_id = ?').run(agent, COMMIT, id);
  recordSubmitHandoff(board.db, id, { version: 1, id: `job-${id}`, agentId: agent, commit: COMMIT, executionTree: 't'.repeat(40), digest: 'digest', state, gateGreen: false });
}

test('clause 1: a seat holding a red-gated item gets that item from next before any new build [C7,#4014]', t => {
  const { board, builder, fresh, red } = fixture(t);
  const freeze = item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'digest:bar' });
  store.claim(board, red, { agentId: builder, lane: 'core', leaseMs: 7_200_000, freeze });
  leaveRed(board, red, builder);
  const next = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(next.item.item_id, red, 'its own red item comes first');
  assert.notEqual(next.item.item_id, fresh);
});

test('clause 2: a red-gated item with no holder is offered ahead of a never-built item [C7,#4014]', t => {
  const { board, builder, other, fresh, red } = fixture(t);
  assert.equal(store.nextFor(board, { agentId: other, lane: 'core' }).item.item_id, fresh, 'without a red, the lower id leads');
  leaveRed(board, red, builder);
  assert.equal(store.nextFor(board, { agentId: other, lane: 'core' }).item.item_id, red, 'the red item leads once it has a built red gate');
});

test('clause 2: a gate red only on main reds, or still running, does not jump the queue [C7,#4014]', t => {
  const { board, builder, other, fresh, red } = fixture(t);
  leaveRed(board, red, builder, 'running');
  assert.equal(store.nextFor(board, { agentId: other, lane: 'core' }).item.item_id, fresh);
});

test('clause 3: next answers in under 0.25 s on a board of 4,000 items, some built and red [C7,#4014]', t => {
  const { board, builder, other, red } = fixture(t);
  leaveRed(board, red, builder);
  for (let n = 0; n < 4000; n++) store.addItem(board, { by: 'coordinator', lane: 'core', title: `Filler ${n}`, criterion: 'prove', specIds: ['C7'], route: 'mid', check: 'true', brief: `Files: src/filler-${n}.js\nTest: proves it` });
  const started = performance.now();
  const next = store.nextFor(board, { agentId: other, lane: 'core' });
  const ms = performance.now() - started;
  assert.equal(next.item.item_id, red);
  assert.ok(ms < 250, `next took ${ms.toFixed(0)} ms`); // budget: declared by bar clause 3 of #4014, a 0.25 s ceiling on 4,000 items
});
