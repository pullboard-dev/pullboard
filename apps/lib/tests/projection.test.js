/** Recipient seeks preserve decision visibility before indexed metadata projection [B21,B27,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../packages/store/index.js';
import { openBoard } from '../index.js';
import {
  COORDINATION_SHOUT,
  itemShoutReader,
} from '../../../packages/store/index.js';
import { shoutItemId } from '../../../packages/kernel/index.js';

/** Compare the optimized query to the previous all-project-then-filter semantics. */
function reference(board, recipient) {
  const all = store.openDecisions(board);
  if (recipient === null) return all;
  const recipients = [...new Set(Array.isArray(recipient) ? recipient : [recipient])];
  return all.filter(ask => recipients.includes(ask.shout_to)
    || ask.shout_to === COORDINATION_SHOUT && recipients.includes('coordinator')
    || shoutItemId(ask.shout_to) !== null && recipients.some(agent => itemShoutReader(board.db, shoutItemId(ask.shout_to), agent)));
}

test('lib.projection.recipient-decision-seeks-retain-live-roles-options: recipient decision seeks retain live roles, options and legacy shapes without unrelated projection [B21,B27,C7]', t => {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  for (const [lane, path] of [['coordinator', '/decision-seeks'], ['web', '/decision-seeks/web-1'], ['web', '/decision-seeks/web-2'], ['api', '/decision-seeks/api-1']]) store.register(board, { lane, path });
  const lanes = ['coordinator', 'web', 'api'];
  const item = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Live decision owner' });
  store.claim(board, item, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, freeze: () => ({ text: 'decision seeks', digest: 'decision-seeks' }) });
  const plain = store.shout(board, { from: 'api-1', to: 'web-1', text: 'Legacy direct', decision: true, lanes });
  store.shout(board, { from: 'api-1', to: 'web', text: 'Lane decision', decision: true, lanes });
  store.shout(board, { from: 'api-1', to: 'coordinator', text: 'Coordinator decision', decision: true, lanes });
  store.shout(board, { from: 'api-1', to: 'all', text: 'Shared coordinator question', decision: true, lanes });
  store.shout(board, { from: 'web-1', to: 'coordinator', item, text: 'Structured item choice', decision: true, options: ['ship', 'wait'], lanes });
  for (let i = 0; i < 12; i += 1) store.shout(board, { from: 'web-1', to: 'api', text: `Unrelated ${i}`, decision: true, lanes });
  const audiences = [null, [], 'coordinator', 'person', 'web-1', 'web-2', 'web', ['web-1', 'web', 'web-1'], [`item:${item}`, 'web-1']];
  for (const audience of audiences) assert.deepEqual(store.openDecisions(board, audience), reference(board, audience));
  assert.equal(Object.hasOwn(store.openDecisions(board, 'web-1').find(row => row.shout_id === plain), 'options'), false, 'legacy decisions acquire no synthetic metadata');
  assert.deepEqual(store.openDecisions(board, 'web-1').find(row => row.item === item).options, ['ship', 'wait']);
  const projected = [];
  const seeks = [];
  const observed = { ...board, db: { prepare(sql) {
    const statement = board.db.prepare(sql);
    if (sql.includes('SELECT meta_key,meta_value FROM board_meta')) return { all(...args) { projected.push(...args); return statement.all(...args); } };
    if (sql.includes('SELECT * FROM shout ask')) seeks.push(sql);
    return statement;
  } } };
  const visible = store.openDecisions(observed, 'web-1');
  assert.deepEqual(projected, visible.map(row => `item_decision:${row.shout_id}`), 'only authorized visible rows reach metadata projection');
  assert.ok(seeks.length > 0, 'the live query executes indexed candidate reads');
  for (const sql of seeks) {
    const bindings = sql.includes(' IN (') ? ['web-1'] : [];
    const plan = board.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map(row => row.detail).join('\n');
    assert.match(plan, /SEARCH ask USING INDEX shout_open_decision/u, 'the existing recipient index bounds candidates');
    assert.doesNotMatch(plan, /SCAN (?:ask|reply)/u, 'neither open questions nor answer lookup requires a shout scan');
  }
  // Change live ownership through the real domain; no cached audience/result survives the move.
  store.release(board, item, 'web-1', 'Hand the fixture claim to another builder.', 'OTHER');
  store.claim(board, item, { agentId: 'web-2', lane: 'web', leaseMs: 3_600_000, freeze: () => ({ text: 'decision seeks', digest: 'decision-seeks' }) });
  for (const audience of ['web-1', 'web-2', 'coordinator']) assert.deepEqual(store.openDecisions(board, audience), reference(board, audience));
  assert.equal(store.openDecisions(board, 'web-1').some(row => row.item === item), false);
  assert.equal(store.openDecisions(board, 'web-2').some(row => row.item === item), true);
});
