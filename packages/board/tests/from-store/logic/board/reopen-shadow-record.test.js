/** With moves.shadow on, the reopen writer records each reopen table shadow compare on the board; off, it runs no table [C7,#8388]. */
/** @pullboard-test-input packages/store/src/io/board/reopen-table.js packages/store/src/io/board/reopen.js packages/store/src/io/board/shadow-record.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';

const AT = Date.parse('2026-11-15T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();

/**
 * A board with one submitted item the coordinator can reopen. `shadow` is the board's stand-in for the moves.shadow machine
 * setting; left undefined, the writer reads the test runner's own machine settings, which leave it at its default.
 */
function submitted(t, shadow) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  if (shadow !== undefined) board.movesShadow = shadow;
  const sql = board.db;
  sql.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run('core-1', 'core', '/seat/core-1', 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'reopened', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  const walk = (state, fields) => { const all = { ...fields, item_status: state }; sql.prepare(`UPDATE item SET ${Object.keys(all).map(k => `${k}=?`).join(', ')} WHERE item_id=7`).run(...Object.values(all), ); };
  sql.exec('INSERT INTO temp.moving VALUES (1)');
  walk('claimed', { item_owner: 'core-1', item_lease_until: '2099-01-01T00:00:00.000Z', item_frozen_digest: 'd'.repeat(64) });
  walk('submitted', { item_built_by: 'core-1', item_commit: 'a'.repeat(40) });
  sql.exec('DELETE FROM temp.moving');
  return { board, reopen: () => store.reopen(board, 7, { agentId: 'coordinator', note: 'the criterion needs correction' }) };
}

test('board.reopen-shadow-record.with-moves-shadow-off-the-default: clause 3: with moves.shadow off (the default) a reopen records no shadow compare [C7,#8388]', t => {
  const { board, reopen } = submitted(t);
  reopen();
  assert.equal(store.readShadow(board, 'reopen'), null);
});

test('board.reopen-shadow-record.with-moves-shadow-matching-reopen-adds: clause 2: with moves.shadow on, a matching reopen adds one compare and no disagreement to the reopen table\'s counts [C7,#8388]', t => {
  const { board, reopen } = submitted(t, true);
  reopen();
  const counts = store.readShadow(board, 'reopen');
  assert.equal(counts.compared, 1, 'the reopen was compared once');
  assert.equal(counts.disagreed, 0, `the reopen table agreed: ${JSON.stringify(counts.last)}`);
  assert.equal(counts.since, STAMP);
});

test('board.reopen-shadow-record.with-moves-shadow-reopen-whose-table: clause 1: with moves.shadow on, a reopen whose table answer differs adds one disagreement with the item id and the differing field [C7,#8388]', t => {
  const { board } = submitted(t, true);
  const hook = store.shadowHook(board, 'reopenShadow', 'reopen', store.reopenDiffers, () => false);
  const wrote = [{ kind: 'reopen', by: 'coordinator', detail: JSON.stringify({ commit: 'a', note: 'why', judgment: null }) }];
  hook({ id: 7, decided: { events: [{ kind: 'reopen', by: 'coordinator', detail: { commit: 'a', note: 'other', judgment: null } }] }, wrote });
  hook({ id: 7, decided: { refused: { code: 'COORDINATOR_ONLY' } }, wrote });
  const counts = store.readShadow(board, 'reopen');
  assert.equal(counts.compared, 2);
  assert.equal(counts.disagreed, 2);
  assert.deepEqual(counts.last.map(({ id, differs }) => ({ id, differs })), [{ id: 7, differs: 'events.0.detail.note' }, { id: 7, differs: 'refused' }]);
});
