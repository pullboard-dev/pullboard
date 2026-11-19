/** @pullboard-test-input source-cell packages/board */
// fixture-subject: the store claim writer with the live claim table deciding, for a coordinator seat and a lane seat claiming from a lane worktree
/** The live claim table and the claim writer give one answer: the table reads the lane the claim runs from for the coordinator seat only, every other seat keeps its registered lane [C7,#10883], and both refuse a seat that never joined [C7,#10952]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellClaim } from '../../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';

/** A real board whose claims the live claim table decides, with one open web item. */
function setup(t) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  board.movesLive = { ...(board.movesLive ?? {}), claim: true };
  const item = cellItem(board, { lane: 'web', title: 'Lane fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' });
  return { board, root: project.repo, id: item.item_id };
}

test('board.claim-table.coordinator-lane-from-claim: clause 1: a seat registered in the coordinator lane claiming a web item from a web worktree is not refused WRONG_LANE by the live claim table [C7,#10883]', t => {
  const { board, root, id } = setup(t);
  const seat = cellSeat(board, { lane: 'coordinator', path: root });
  let code = null;
  try { cellClaim(board, id, seat, { root, lane: 'web' }); } catch (error) { code = error.code ?? error.name; }
  assert.notEqual(code, 'WRONG_LANE', 'the table reads the lane the coordinator claims from, as the writer does');
  assert.equal(code, null, 'the claim is written');
  assert.equal(board.db.prepare('SELECT item_status, item_owner FROM item WHERE item_id=?').get(id).item_owner, seat.id);
});

test('board.claim-table.seat-lane-unchanged: clause 2: a seat registered in the api lane claiming a web item with a web lane option is still refused WRONG_LANE by the live claim table [C7,#10883]', t => {
  const { board, root, id } = setup(t);
  const seat = cellSeat(board, { lane: 'api', path: root });
  assert.throws(() => cellClaim(board, id, seat, { root, lane: 'web' }), { code: 'WRONG_LANE' });
  assert.equal(board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(id).item_status, 'open', 'nothing is written');
});

test('board.claim-table.lanes-off-claim-lane: clause 1: claimDecision on a laneMode off board, for a seat registered in web claiming a docs item with the claim lane option docs, is not refused WRONG_LANE [C7,#10902]', t => {
  const { board, root, id } = setup(t);
  const docs = cellItem(board, { lane: 'docs', title: 'Docs fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  const seat = cellSeat(board, { lane: 'web', path: root });
  let code = null;
  try { cellClaim(board, docs, seat, { root, lane: 'docs', laneOff: true }); } catch (error) { code = error.code ?? error.name; }
  assert.notEqual(code, 'WRONG_LANE', 'the table reads the lane the claim runs from, as the writer does');
  assert.equal(board.db.prepare('SELECT item_owner FROM item WHERE item_id=?').get(docs).item_owner, seat.id, 'the claim is written');
});

test('board.claim-table.lanes-on-registered-lane: clause 2: the same claim on a laneMode on board is still refused WRONG_LANE [C7,#10902]', t => {
  const { board, root } = setup(t);
  const docs = cellItem(board, { lane: 'docs', title: 'Docs fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  const seat = cellSeat(board, { lane: 'web', path: root });
  assert.throws(() => cellClaim(board, docs, seat, { root, lane: 'docs' }), { code: 'WRONG_LANE' });
  assert.equal(board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(docs).item_status, 'open', 'nothing is written');
});

/** A reopened core item whose builder holds the first refusal until 60 minutes after `base`, on a board whose clock the test moves; line.takeoverMinutes is 15. */
function reopened(t) {
  const base = Date.parse('2026-10-24T00:00:00Z');
  let at = base;
  const board = cellBoard(t, ':memory:', { now: () => new Date(at) });
  board.movesLive = { claim: true };
  cellSeat(board, { lane: 'coordinator', path: '/seat/coordinator' });
  const builder = cellSeat(board, { lane: 'core', path: '/seat/builder' });
  const other = cellSeat(board, { lane: 'core', path: '/seat/other' });
  const { item_id: id } = cellItem(board, { lane: 'core', title: 'Returned work', criterion: '1. the claim is recorded [test].', route: 'strong', check: 'true' });
  board.db.prepare('UPDATE item SET item_built_by = ? WHERE item_id = ?').run(builder.id, id);
  const detail = { reopenFirstRefusal: { builder: builder.id, until: new Date(base + 60 * 60_000).toISOString() } };
  board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)').run(new Date(base).toISOString(), 'coordinator', 'reopen', id, JSON.stringify(detail));
  store.setLineSetting(board, { agentId: 'coordinator', key: 'takeoverMinutes', value: 15, reason: 'seeded takeover window', window: { activeReviewers: 1, submissions: 5 } });
  // The builder's seat keeps making moves, so only the line takeover wait, never a gone seat, ends its window.
  const minutes = (n) => {
    at = base + n * 60_000;
    board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)').run(new Date(at).toISOString(), builder.id, 'fact', null, '{}');
  };
  return { board, id, other, minutes };
}

const freeze = () => ({ text: '{}', digest: 'claim-table-fixture' });

test('board.claim-table.unjoined-seat-refused-joined-allowed: clause 2: with moves.live.claim on, the claim refuses NOT_JOINED for a seat that never joined and writes nothing, and the same claim by a joined seat is written [C7]', t => {
  const board = cellBoard(t, ':memory:');
  board.movesLive = { claim: true };
  cellSeat(board, { lane: 'coordinator', path: '/seat/coordinator' });
  const joined = cellSeat(board, { lane: 'core', path: '/seat/builder' });
  const { item_id: id } = cellItem(board, { lane: 'core', title: 'Unjoined claim', criterion: '1. the claim is recorded [test].', route: 'strong', check: 'true' });
  const claim = agentId => store.claim(board, id, { agentId, lane: 'core', leaseMs: 60 * 60_000, freeze });
  assert.throws(() => claim('core-99'), error => error.code === 'NOT_JOINED', 'a seat with no agent row is refused');
  assert.equal(board.db.prepare("SELECT COUNT(*) n FROM event WHERE item_id=? AND event_kind='claim'").get(id).n, 0, 'the refusal wrote no claim');
  claim(joined.id);
  assert.equal(board.db.prepare('SELECT item_owner owner FROM item WHERE item_id=?').get(id).owner, joined.id, 'the joined seat holds the item');
});

test('board.claim-table.takeover-window-ends-first-refusal: clause 1: claimDecision for a reopened item past the recorded line takeoverMinutes and inside reopenFirstRefusalMinutes is not refused REOPEN_HELD_FOR_BUILDER, matching the writer [test] [C7,#10903]', t => {
  const { board, id, other, minutes } = reopened(t);
  minutes(15);
  store.claim(board, id, { agentId: other.id, lane: 'core', leaseMs: 60 * 60_000, freeze });
  assert.equal(board.db.prepare('SELECT item_owner owner FROM item WHERE item_id=?').get(id).owner, other.id, 'the takeover claim is written');
});

test('board.claim-table.first-refusal-before-takeover: clause 2: the same claim before takeoverMinutes is still refused REOPEN_HELD_FOR_BUILDER [test] [C7,#10903]', t => {
  const { board, id, other, minutes } = reopened(t);
  minutes(14);
  assert.throws(() => store.claim(board, id, { agentId: other.id, lane: 'core', leaseMs: 60 * 60_000, freeze }), error => error.code === 'REOPEN_HELD_FOR_BUILDER');
  assert.equal(board.db.prepare('SELECT item_status status FROM item WHERE item_id=?').get(id).status, 'open', 'nothing is written');
});
