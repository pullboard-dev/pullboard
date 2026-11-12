/** Modern claims and historical guards [B5,B12,H16]. */
import assert from 'node:assert/strict';
import { beforeEach } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../index.js';
import { registerPreGrant } from '../../../../cli/tests/fixtures/seats.js';
const HOUR = 3_600_000;
let board;
const freeze = item => ({ text: item.item_title, digest: `digest:${item.item_title}` });
const claimAs = (id, agentId, lane) => store.claim(board, id, { agentId, lane, leaseMs: 2 * HOUR, freeze });
beforeEach(() => {
  board = openBoard(':memory:', { now: () => new Date('2026-10-04T12:00:00Z') });
  registerPreGrant(board, [['coordinator', '/repo', { family: 'Fixture Coordinator' }], ['web', '/repo-web-1', { family: 'Fixture Builder One' }], ['web', '/repo-web-2', { family: 'Fixture Builder Two' }], ['api', '/repo-api-1', { family: 'Fixture Reviewer' }]]);
});

test('modern multi-claim retains legacy guards and lane holds [B5, B12]', () => {
  const first = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'One' });
  const second = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Two' });
  const child = store.addItem(board, { by: 'web-1', lane: 'web', title: 'One, part', parentId: first });
  const api = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Endpoint' });
  claimAs(first, 'web-1', 'web');
  assert.throws(() => claimAs(second, 'web-1', 'web'), /ONE_CLAIM/, 'a legacy claim retains the historical guard');
  assert.equal(store.claim(board, second, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze, itemFolder: true }).renewed, false);
  assert.equal(store.getItem(board, first).item_owner, 'web-1');
  assert.equal(store.getItem(board, second).item_owner, 'web-1');
  assert.equal(store.claim(board, first, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze, itemFolder: true }).renewed, true);
  assert.equal(store.claim(board, second, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze, itemFolder: true }).renewed, true);
  claimAs(child, 'web-1', 'web');
  assert.throws(() => claimAs(api, 'web-1', 'web'), /WRONG_LANE/);
  assert.throws(() => claimAs(api, 'coordinator', 'coordinator'), /WRONG_LANE.*built from that lane's worktree, never the main checkout/);
  const notes = store.addItem(board, { by: 'coordinator', lane: 'coordinator', title: 'Release notes' });
  assert.equal(claimAs(notes, 'coordinator', 'coordinator').renewed, false);
  assert.throws(
    () => store.addItem(board, { by: 'web-1', lane: 'api', title: 'Cross', parentId: first }),
    /PARENT_LANE/,
  );
});

test('modern claims enforce the approved ten-item cap without blocking renewal [B5,H16]', () => {
  const ids = Array.from({ length: 11 }, (_, index) => store.addItem(board, { by: 'coordinator', lane: 'web', title: `Item ${index}` }));
  const child = store.addItem(board, { by: 'web-1', lane: 'web', title: 'Child', parentId: ids[0] });
  const options = { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze, itemFolder: true, perSeat: 10 };
  for (const id of ids.slice(0, 10)) assert.equal(store.claim(board, id, options).renewed, false);
  assert.equal(store.claim(board, ids[0], options).renewed, true);
  assert.throws(() => store.claim(board, ids[10], options), /ONE_CLAIM.*ten live claims/);
  assert.throws(() => claimAs(child, 'web-1', 'web'), /ONE_CLAIM.*ten live claims/, 'legacy-shaped children cannot bypass the modern cap');
  assert.equal(store.getItem(board, ids[10]).item_status, 'open');
});

