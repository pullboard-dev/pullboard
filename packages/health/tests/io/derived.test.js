// fixture-subject: addItem (a unit test of readDerivedState over a swept derived file; the board is opened through the fixture kit)
/** readDerivedState returns the five swept kinds for a main commit and null when the table is not current for it [C7,#8945,#10568]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { sweepDerivedState } from '../../index.js';
import { readDerivedState } from '../../index.js';
import { sweepDerivedAtMain } from '../../index.js';

const MAIN = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** A file-backed board with two seats, one held open item and one accepted unlanded item. */
function sweptBoard(t, { empty = false } = {}) {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const ids = empty ? [] : [1, 2].map(n => store.addItem(board, { by: 'coordinator', lane: 'web', title: `Read item ${n}` }));
  if (!empty) {
    store.holdItem(board, ids[0], { agentId: 'coordinator', reason: 'Private hold' });
    board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES ('2026-11-16T00:00:00.000Z', 'fixture', 'accept', ?, '{}')").run(ids[1]);
    board.db.prepare("INSERT INTO agent (agent_id, agent_lane, agent_path, agent_family, agent_created_at) VALUES ('web-1', 'web', '/seats/web-1', 'anthropic', '2026-11-17T00:00:00.000Z')").run();
  }
  const listItems = () => board.db.prepare('SELECT * FROM item ORDER BY item_id').all().map((item, index) => (index === 1 ? { ...item, item_status: 'verified' } : item));
  const sweep = (mainCommit, enabled = true) => sweepDerivedState(board, { mainCommit, enabled, listItems, verdictState: () => ({ code: 'STALE_VERDICT' }), gateAtHead: (_b, item) => (item.item_id === ids[0] ? 'gate green at cccccccccccc' : null) });
  return { board, ids, sweep };
}

test('health.derived-read.matches-sweep: clause 1: after the sweep at a main commit, readDerivedState returns the five kinds equal to the rows the sweep wrote [C7,#10568]', t => {
  const { board, ids, sweep } = sweptBoard(t);
  sweep(MAIN);
  const state = readDerivedState(board, { mainCommit: MAIN, enabled: true });
  assert.deepEqual([...state.holds.keys()], [String(ids[0])]);
  assert.equal(state.holds.get(String(ids[0])).reason, 'Private hold');
  assert.deepEqual([...state.verdicts], [[String(ids[1]), { code: 'STALE_VERDICT' }]]);
  assert.equal(state.acceptOrder.size, 1);
  assert.ok(state.acceptOrder.get(String(ids[1])) > 0);
  assert.deepEqual([...state.seatFamilies], [['web-1', 'anthropic']]);
  assert.deepEqual([...state.gateAtHead], [[String(ids[0]), 'gate green at cccccccccccc']]);
});

test('health.derived-read.null-unless-current: clause 2: it returns null for a never-swept commit, a moved-on commit, the setting off and an in-memory board, not for empty kinds [C7,#10568]', t => {
  const { board, sweep } = sweptBoard(t);
  assert.equal(readDerivedState(board, { mainCommit: MAIN, enabled: true }), null, 'no file yet');
  sweep(MAIN);
  assert.equal(readDerivedState(board, { mainCommit: OTHER, enabled: true }), null, 'never swept at that commit');
  assert.equal(readDerivedState(board, { mainCommit: MAIN, enabled: false }), null, 'setting off');
  sweep(OTHER);
  assert.notEqual(readDerivedState(board, { mainCommit: OTHER, enabled: true }), null);
  const memory = fixtureBoard(t, { storage: 'memory' });
  assert.equal(readDerivedState(memory, { mainCommit: MAIN, enabled: true }), null, 'in-memory board');
  const emptied = sweptBoard(t, { empty: true });
  emptied.sweep(MAIN);
  const state = readDerivedState(emptied.board, { mainCommit: MAIN, enabled: true });
  assert.ok(state, 'swept with every kind empty still reads as current');
  assert.equal(state.verdicts.size + state.holds.size + state.acceptOrder.size + state.seatFamilies.size + state.gateAtHead.size, 0);
});

test('health.derived-read.sweeps-only-when-not-current: clause 1: sweepDerivedAtMain runs sweepDerivedState when readDerivedState is null at the main commit and returns its counts, and sweeps nothing once the table is current there [C7,#3010]', t => {
  const { board, ids } = sweptBoard(t);
  const listItems = () => board.db.prepare('SELECT * FROM item ORDER BY item_id').all().map((item, index) => (index === 1 ? { ...item, item_status: 'verified' } : item));
  const readers = { listItems, verdictState: () => ({ code: 'STALE_VERDICT' }), gateAtHead: () => null };
  assert.equal(sweepDerivedAtMain(board, { mainCommit: MAIN, enabled: false, readers }), null, 'setting off sweeps nothing');
  assert.equal(readDerivedState(board, { mainCommit: MAIN, enabled: true }), null, 'not current before the sweep');
  const swept = sweepDerivedAtMain(board, { mainCommit: MAIN, enabled: true, readers });
  assert.deepEqual(swept.counts, { hold: 1, verdict: 1, 'accept-order': 1, 'seat-family': 1, 'gate-at-head': 0 });
  assert.deepEqual([...readDerivedState(board, { mainCommit: MAIN, enabled: true }).holds.keys()], [String(ids[0])]);
  assert.equal(sweepDerivedAtMain(board, { mainCommit: MAIN, enabled: true, readers }), null, 'already current at this commit: nothing is swept');
  assert.notEqual(sweepDerivedAtMain(board, { mainCommit: OTHER, enabled: true, readers }), null, 'a moved-on commit is swept');
});
