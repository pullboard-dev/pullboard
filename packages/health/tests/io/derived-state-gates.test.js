// fixture-subject: addItem (a unit test of the one derived-state sweep over seeded seats and queued items; the board is opened through the fixture kit)
/** One derived-state sweep also writes seat families and gate-at-head, all five kinds in one transaction, beside the board [C7,#8944,#8977]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../store/index.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { sweepDerivedState } from '../../index.js';
import { derivedStatePath } from '../../index.js';

const MAIN = 'e'.repeat(40);

/** A file-backed board with two registered seats of different families and three open items, one of them held. */
function seatedBoard(t) {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const ids = [1, 2, 3].map(n => store.addItem(board, { by: 'coordinator', lane: 'web', title: `Queued item ${n}` }));
  store.holdItem(board, ids[2], { agentId: 'coordinator', reason: 'Private hold' });
  const add = board.db.prepare("INSERT INTO agent (agent_id, agent_lane, agent_path, agent_family, agent_created_at) VALUES (?, 'web', ?, ?, '2026-11-17T00:00:00.000Z')");
  add.run('web-1', '/seats/web-1', 'anthropic');
  add.run('web-2', '/seats/web-2', 'openai');
  board.db.prepare("INSERT INTO agent (agent_id, agent_lane, agent_path, agent_created_at) VALUES ('web-3', 'web', '/seats/web-3', '2026-11-17T00:00:00.000Z')").run();
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  const listItems = () => board.db.prepare('SELECT * FROM item ORDER BY item_id').all();
  return { board, file, ids, listItems };
}

/** What the store's gate-at-head reader would say: item 1 has a queued gate at its head, item 2 a green one, item 3 none. */
const gateFor = ids => (_board, item) => (item.item_id === ids[0] ? 'gate queued at aaaaaaaaaaaa' : item.item_id === ids[1] ? 'gate green at bbbbbbbbbbbb' : null);

/** The rows of the derived file for one commit and kind, in key order. */
function rows(file, kind) {
  const derived = new DatabaseSync(derivedStatePath(file), { readOnly: true });
  try { return derived.prepare('SELECT key, value FROM derived_state WHERE main_commit = ? AND kind = ? ORDER BY key').all(MAIN, kind).map(row => [row.key, row.value]); }
  finally { derived.close(); }
}

test('health.derived-gates.seat-family-matches-board: clause 1: the sweep writes seat-family rows equal to the families the board records for that main commit [C7,#8977]', t => {
  const { board, file, listItems, ids } = seatedBoard(t);
  const written = sweepDerivedState(board, { mainCommit: MAIN, enabled: true, listItems, verdictState: () => null, gateAtHead: gateFor(ids) });
  assert.equal(written.file, derivedStatePath(file));
  const recorded = board.db.prepare('SELECT agent_id, agent_family FROM agent WHERE agent_family IS NOT NULL ORDER BY agent_id').all().map(row => [row.agent_id, row.agent_family]);
  assert.deepEqual(rows(file, 'seat-family'), recorded);
  assert.deepEqual(recorded, [['web-1', 'anthropic'], ['web-2', 'openai']], 'a seat with no declared family has no row');
});

test('health.derived-gates.gate-at-head-matches-reader: clause 2: the gate-at-head rows equal what gateAtHead computes for each queued item [C7,#8977]', t => {
  const { board, file, listItems, ids } = seatedBoard(t);
  const gateAtHead = gateFor(ids);
  sweepDerivedState(board, { mainCommit: MAIN, enabled: true, listItems, verdictState: () => null, gateAtHead });
  const computed = listItems().filter(item => item.item_status === 'open').map(item => [String(item.item_id), gateAtHead(board, item)]).filter(row => row[1]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.deepEqual(rows(file, 'gate-at-head'), computed);
  assert.equal(computed.length, 2, 'an item with no gate at its head has no row');
});

test('health.derived-gates.five-kinds-one-transaction: clause 3: one sweep writes all five kinds in one transaction, and a failure part-way writes none [C7,#8977]', t => {
  const { board, file, listItems, ids } = seatedBoard(t);
  const written = sweepDerivedState(board, { mainCommit: MAIN, enabled: true, listItems, verdictState: () => null, gateAtHead: gateFor(ids) });
  assert.deepEqual(Object.keys(written.counts).sort(), ['accept-order', 'gate-at-head', 'hold', 'seat-family', 'verdict']);
  assert.deepEqual(rows(file, 'hold').map(row => row[0]), [String(ids[2])], 'the held item is the one hold row');
  const derived = new DatabaseSync(derivedStatePath(file), { readOnly: true });
  try { assert.equal(derived.prepare('SELECT COUNT(*) AS n FROM derived_state WHERE main_commit = ?').get(MAIN).n, Object.values(written.counts).reduce((a, b) => a + b, 0)); }
  finally { derived.close(); }
  const NEXT = 'f'.repeat(40);
  assert.throws(() => sweepDerivedState(board, { mainCommit: NEXT, enabled: true, listItems, verdictState: () => null, gateAtHead: () => { throw new Error('gate reader down'); } }), /gate reader down/u);
  const after = new DatabaseSync(derivedStatePath(file), { readOnly: true });
  try { assert.equal(after.prepare('SELECT COUNT(*) AS n FROM derived_state WHERE main_commit = ?').get(NEXT).n, 0, 'the failed sweep left no rows for its commit'); }
  finally { after.close(); }
});

test('health.derived-gates.off-writes-nothing: clause 3: with health.derivedState off the one sweep writes no file [C7,#8977]', t => {
  const { board, listItems, ids } = seatedBoard(t);
  assert.equal(sweepDerivedState(board, { mainCommit: MAIN, enabled: false, listItems, verdictState: () => null, gateAtHead: gateFor(ids) }), null);
});
