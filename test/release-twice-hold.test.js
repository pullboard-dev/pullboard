/** Two coded claim releases leave a visible hold and one coordinator notice [C7,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { openBoard } from '../src/native-board.js';

const commit = 'a'.repeat(40);
test('two releases hold the item until coordinator lifts it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-release-twice-'));
  const board = openBoard(join(dir, 'board.sqlite'));
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const first = store.register(board, { lane: 'core', path: '/one', route: 'strong' });
  const second = store.register(board, { lane: 'core', path: '/two', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'work', criterion: 'prove it', route: 'strong' });
  const claim = agentId => store.claim(board, id, { agentId, lane: 'core', leaseMs: 7200000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit, verify: { policy: 'any', family: 'off' } } }), digest: 'digest' }) });
  claim(first); store.release(board, id, first, '', 'INELIGIBLE');
  assert.equal(store.getItem(board, id).item_hold_reason, null);
  claim(second); store.release(board, id, second, '', 'BLOCKED');
  const held = store.getItem(board, id);
  assert.match(held.item_hold_reason, new RegExp(`${first}: INELIGIBLE`));
  assert.match(held.item_hold_reason, new RegExp(`${second}: BLOCKED`));
  assert.equal(store.inbox(board, 'coordinator').filter(row => row.shout_text.includes(`#${id} held after two releases`)).length, 1);
  assert.notEqual(store.nextFor(board, { agentId: first, lane: 'core' }).item?.item_id, id);
  assert.throws(() => claim(first), error => error.code === 'ITEM_HELD');
  store.releaseItemHold(board, id, { agentId: 'coordinator' });
  claim(first); store.release(board, id, first, '', 'BLOCKED');
  assert.equal(store.getItem(board, id).item_hold_reason, null, 'lifting starts a new release episode');
  assert.equal(store.inbox(board, 'coordinator').filter(row => row.shout_text.includes(`#${id} held after two releases`)).length, 1);
});
