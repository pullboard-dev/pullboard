/** A landing whose merged tree is exactly the item's green gated tree reuses that gate instead of rerunning [C7,#2902]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { openBoard } from '../apps/lib/index.js';
import { provenTreeGate } from '../packages/landing/src/shell/landing-step-trunk.js';

const TREE = 't'.repeat(40);
const COMMIT = 'c'.repeat(40);

/** A board with one item whose submit gate went green on TREE at COMMIT under its frozen bar. */
function fixture(t, job = {}) {
  const board = openBoard(':memory:', { now: () => new Date('2026-11-04T08:00:00.000Z') });
  t.after(() => store.closeBoard(board));
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Reuse a proven tree' });
  board.db.prepare('UPDATE item SET item_frozen_digest = ? WHERE item_id = ?').run('digest', id);
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(`submit_handoff:${id}`,
    JSON.stringify({ version: 1, id: 'job-1', agentId: 'core-1', commit: COMMIT, executionTree: TREE, digest: 'digest', state: 'green', gateGreen: true, ...job }));
  return { board, id };
}

test('the item\'s green gate on exactly this merged tree is the landing proof, with no rerun [C7,#2902]', t => {
  const { board, id } = fixture(t);
  const proven = provenTreeGate(board, [{ id, commit: COMMIT }], TREE);
  assert.deepEqual(proven, { isGreen: true, tree: TREE, failures: [], logPath: null, reusedSubmitGate: 'job-1' });
});

test('a different tree, commit, bar, gate state or a multi-item batch runs the plan as before [C7,#2902]', t => {
  const { board, id } = fixture(t);
  assert.equal(provenTreeGate(board, [{ id, commit: COMMIT }], 'u'.repeat(40)), null, 'main moved, so the merged tree differs');
  assert.equal(provenTreeGate(board, [{ id, commit: 'd'.repeat(40) }], TREE), null, 'another head');
  assert.equal(provenTreeGate(board, [{ id, commit: COMMIT }, { id: id + 1, commit: COMMIT }], TREE), null, 'two items');
  const red = fixture(t, { state: 'red' });
  assert.equal(provenTreeGate(red.board, [{ id: red.id, commit: COMMIT }], TREE), null, 'a red gate proves nothing');
  const rebarred = fixture(t, { digest: 'old-digest' });
  assert.equal(provenTreeGate(rebarred.board, [{ id: rebarred.id, commit: COMMIT }], TREE), null, 'a changed bar needs its own run');
});
