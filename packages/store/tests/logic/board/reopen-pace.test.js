/** With moves.live.reopen on, the reopen writer hands the reopen table the item's frozen pace and landing history, so a sprint red gate after landing queues its pull-out; steady writes what it wrote before [C7,M2,#9209]. */
/** @pullboard-test-input packages/store/src/io/board/reopen.js packages/store/src/io/board/reopen-table.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';

const AT = Date.parse('2026-11-16T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();
const [COMMIT, MERGED] = ['a'.repeat(40), 'e'.repeat(40)];
const RED = `packages/a/tests/queue.test.js: keeps the queue whole; merge commit ${MERGED}`;

/** A board with one submitted item already landed at MERGED, its bar frozen at `pace` (none: steady); `live` stands in for moves.live.reopen. */
function landed(t, pace, live) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  board.movesLive = { reopen: live };
  const sql = board.db;
  sql.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run('core-1', 'core', '/seat/core-1', 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  const walk = (state, fields) => { const all = { ...fields, item_status: state }; sql.prepare(`UPDATE item SET ${Object.keys(all).map(k => `${k}=?`).join(', ')} WHERE item_id=7`).run(...Object.values(all)); };
  sql.exec('INSERT INTO temp.moving VALUES (1)');
  walk('claimed', { item_owner: 'core-1', item_lease_until: '2099-01-01T00:00:00.000Z', item_frozen_digest: 'd'.repeat(64), item_frozen: JSON.stringify({ criterion: 'x', ...(pace ? { pace } : {}) }) });
  walk('submitted', { item_built_by: 'core-1', item_commit: COMMIT, item_merged_commit: MERGED });
  sql.exec('DELETE FROM temp.moving');
  return { board, reopen: () => store.reopen(board, 7, { agentId: 'coordinator', note: RED }) };
}

/** The item's events after the given id, as written. */
const written = (board, after = 0) => board.db.prepare('SELECT event_kind kind, event_by by, event_detail detail FROM event WHERE item_id=7 AND event_id>? ORDER BY event_id').all(after)
  .map(({ kind, by, detail }) => ({ kind, by, detail }));
const lastId = board => board.db.prepare('SELECT COALESCE(MAX(event_id),0) id FROM event').get().id;

test('clause 1: with moves.live.reopen on, a landed sprint submission reopened with a red gate note writes one reopen and one pull_out, and its landing reads pulling [C7,M2,#9209]', t => {
  const { board, reopen } = landed(t, 'sprint', true);
  const before = lastId(board);
  reopen();
  const events = written(board, before).filter(e => ['reopen', 'pull_out'].includes(e.kind));
  assert.deepEqual(events.map(e => e.kind), ['reopen', 'pull_out']);
  assert.equal(JSON.parse(events[0].detail).landingFailure, RED);
  assert.deepEqual(JSON.parse(events[1].detail), { commit: COMMIT, mergedCommit: MERGED, builder: 'core-1', reason: 'GATE_RED', failure: RED });
  assert.equal(events[1].by, 'coordinator');
  assert.equal(store.getItem(board, 7).item_status, 'open');
  const history = written(board).map(e => ({ kind: e.kind }));
  assert.equal(history.findLast(e => ['merged', 'pull_out', 'pulled', 'published'].includes(e.kind))?.kind, 'pull_out', 'its landing reads pulling');
});

test('clause 2: a steady item reopened the same way writes exactly the reopen event the writer writes on its own, byte for byte, and no pull_out [C7,M2,#9209]', t => {
  const runs = [[undefined, true], ['steady', true], [undefined, false]].map(([pace, live]) => {
    const { board, reopen } = landed(t, pace, live);
    const before = lastId(board);
    reopen();
    return written(board, before).filter(e => !['shout'].includes(e.kind));
  });
  for (const events of runs) assert.deepEqual(events.map(e => e.kind), ['reopen']);
  assert.equal(runs[0][0].detail, runs[2][0].detail, 'live steady writes the writer\'s own reopen detail byte for byte');
  assert.equal(runs[1][0].detail, runs[0][0].detail, 'a bar frozen at steady reads as no pace');
  assert.equal('landingFailure' in JSON.parse(runs[0][0].detail), false);
});
