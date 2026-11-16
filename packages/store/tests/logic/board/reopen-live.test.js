/** With moves.live.reopen on, the reopen writer writes the reopen table's events and refuses what the table refuses; off, its own rules decide [C7,#8390]. */
/** @pullboard-test-input packages/store/src/io/board/reopen.js packages/store/src/io/board/reopen-table.js packages/store/src/logic/board/landing/lease.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';

const AT = Date.parse('2026-11-15T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();

/** A board with one submitted item the coordinator can reopen; `live` stands in for the moves.live.reopen machine setting. */
function submitted(t, live) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  if (live !== undefined) board.movesLive = { reopen: live };
  const sql = board.db;
  sql.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run('core-1', 'core', '/seat/core-1', 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'reopened', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  const walk = (state, fields) => { const all = { ...fields, item_status: state }; sql.prepare(`UPDATE item SET ${Object.keys(all).map(k => `${k}=?`).join(', ')} WHERE item_id=7`).run(...Object.values(all)); };
  sql.exec('INSERT INTO temp.moving VALUES (1)');
  walk('claimed', { item_owner: 'core-1', item_lease_until: '2099-01-01T00:00:00.000Z', item_frozen_digest: 'd'.repeat(64) });
  walk('submitted', { item_built_by: 'core-1', item_commit: 'a'.repeat(40) });
  sql.exec('DELETE FROM temp.moving');
  return { board, reopen: () => store.reopen(board, 7, { agentId: 'coordinator', note: 'the criterion needs correction' }) };
}

/** The item's reopen events, as written. */
const reopens = board => board.db.prepare("SELECT event_kind kind, event_by by, event_detail detail FROM event WHERE item_id=7 AND event_kind='reopen' ORDER BY event_id").all()
  .map(({ kind, by, detail }) => ({ kind, by, detail: JSON.parse(detail) }));

/** Stand in for the injected move tables with `answer` as the reopen table's whole answer, so a test can make the table refuse or throw. */
function tableSays(answer) {
  store.provideMoveTables({ runTable: () => answer(), reopenEngine: () => ({ table: {}, rules: {} }) });
}

test('clause 1: with moves.live.reopen on, a reopen writes exactly the events the reopen table decides [C7,#8390]', t => {
  const shadowed = submitted(t, false);
  let decided = null;
  shadowed.board.reopenShadow = answer => { decided = answer.decided; };
  shadowed.reopen();
  assert.equal(decided?.events?.length, 1, 'the reopen table decided the reopen event');
  const live = submitted(t, true);
  live.reopen();
  const wrote = reopens(live.board);
  assert.equal(wrote.length, 1);
  assert.equal(wrote[0].by, decided.events[0].by);
  for (const [key, value] of Object.entries(decided.events[0].detail)) assert.deepEqual(wrote[0].detail[key], value, `the written ${key} is the table's`);
  assert.equal(store.getItem(live.board, 7).item_status, 'open');
});

test('clause 3: with moves.live.reopen off (the default) the writer\'s own rules decide, whatever the table says [C7,#8390]', t => {
  const { board, reopen } = submitted(t);
  reopen();
  assert.equal(reopens(board).length, 1);
  assert.equal(store.getItem(board, 7).item_status, 'open');
});

test('clause 2: with moves.live.reopen on, a reopen the table refuses is refused with the table\'s code and writes nothing [C7,#8390]', t => {
  const { board, reopen } = submitted(t, true);
  tableSays(() => ({ refused: { code: 'COORDINATOR_ONLY', message: 'only the coordinator reopens submissions', next: 'ask the coordinator' } }));
  assert.throws(reopen, error => error.code === 'COORDINATOR_ONLY' && error.next === 'ask the coordinator');
  assert.equal(reopens(board).length, 0, 'a refused reopen writes no event');
  assert.equal(store.getItem(board, 7).item_status, 'submitted');
});

test('clause 2: a reopen table that throws never takes the reopen down; the writer\'s own event is written [C7,#8390]', t => {
  const { board, reopen } = submitted(t, true);
  tableSays(() => { throw new Error('table broke'); });
  reopen();
  assert.equal(reopens(board).length, 1);
  assert.equal(store.getItem(board, 7).item_status, 'open');
});
