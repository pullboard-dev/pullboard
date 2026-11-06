/** The board names each item's pipeline stage from its status and latest hand-off, one helper for every reader [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { fixtureBoard } from './board-fixture.js';

const freeze = () => ({ text: '{}', digest: 'stage-fixture' });

/** Run a raw status write under the move token the board's status trigger requires. */
function asMove(board, sql, ...args) {
  board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
  try { board.db.prepare(sql).run(...args); } finally { board.db.exec('DELETE FROM temp.moving'); }
}

/** Write the item's latest submit hand-off record the way the submit queue does. */
function handoff(board, id, job) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(`submit_handoff:${id}`, JSON.stringify({ commit: 'a'.repeat(40), agentId: board.db.prepare('SELECT item_owner FROM item WHERE item_id=?').get(id)?.item_owner, digest: 'stage-fixture', ...job }));
}

test('clause 1: show, list and the board read name building, in the gate, back with builder, in review, accepted and landed [C7]', t => {
  const board = fixtureBoard(t);
  const make = title => store.addItem(board, { by: 'coordinator', lane: 'web', title });
  const [building, gated, running, red, review, accepted, landed] = ['b', 'g', 'r', 'x', 'v', 'a', 'l'].map(make);
  [building, gated, running, red].forEach((id, n) => store.claim(board, id, { agentId: `web-${n + 1}`, lane: 'web', leaseMs: 3_600_000, freeze }));
  handoff(board, gated, { state: 'queued' });
  handoff(board, running, { state: 'running' });
  handoff(board, red, { state: 'red' });
  handoff(board, review, { state: 'green' });
  asMove(board, "UPDATE item SET item_status='submitted' WHERE item_id=?", review);
  asMove(board, "UPDATE item SET item_status='verified' WHERE item_id IN (?,?)", accepted, landed);
  board.db.prepare("INSERT INTO event(item_id,event_kind,event_by,event_at,event_detail) VALUES (?,?,?,?,?)")
    .run(landed, 'merged', 'coordinator', new Date().toISOString(), '{}');
  const want = { [building]: 'building', [gated]: 'in the gate', [running]: 'in the gate', [red]: 'back with builder',
    [review]: 'in review', [accepted]: 'accepted', [landed]: 'landed' };
  const listed = store.listItems(board, { all: true });
  for (const [id, stage] of Object.entries(want)) {
    assert.equal(listed.find(item => item.item_id === Number(id)).item_stage, stage, `list #${id}`);
    assert.equal(store.getItem(board, Number(id)).item_stage, stage, `show #${id}`);
  }
});

test('clause 2: status counts items per stage, not per raw status [C7]', t => {
  const board = fixtureBoard(t);
  const make = title => store.addItem(board, { by: 'coordinator', lane: 'web', title });
  const [a, b, c] = ['a', 'b', 'c'].map(make);
  [a, b, c].forEach((id, n) => store.claim(board, id, { agentId: `web-${n + 1}`, lane: 'web', leaseMs: 3_600_000, freeze }));
  handoff(board, a, { state: 'queued' });
  handoff(board, b, { state: 'running' });
  const { stages, items } = store.stats(board);
  assert.equal(items.claimed, 3);
  assert.equal(stages['in the gate'], 2);
  assert.equal(stages.building, 1);
  assert.deepEqual(Object.keys(stages), store.ITEM_STAGES);
});
