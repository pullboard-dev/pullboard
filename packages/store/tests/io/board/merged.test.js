/** With composeLanding in its args, recording a parent's landing closes its submitted slices in the same write [C7,#2397]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { board_ensureCoordinator } from '../../../index.js';
import { getItem } from '../../../index.js';
import { merged } from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';

const COMMIT = 'b'.repeat(40);

/** A board with an open parent, two submitted slice children of it and one submitted child that is not a slice. */
function setup(t) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  board_ensureCoordinator(board, project.repo);
  const make = title => cellItem(board, { lane: 'web', title, criterion: '1. It works [test]', route: 'strong', check: 'true' }).item_id;
  const parent = make('Parent');
  const child = (title, slice) => {
    const id = make(title);
    // The status guard admits a write only while the move token is set, as moveItem sets it, so the fixture states a submitted child this way.
    board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
    try { board.db.prepare("UPDATE item SET item_parent_id = ?, item_status = 'submitted', item_built_by = 'fixture-seat', item_commit = ?, item_frozen_digest = 'fixture' WHERE item_id = ?").run(parent, 'c'.repeat(40), id); } finally { board.db.exec('DELETE FROM temp.moving'); }
    if (slice) board.db.prepare('INSERT INTO board_meta(meta_key, meta_value) VALUES (?, ?)').run(`item-slice:${id}`, '{}');
    return id;
  };
  const slices = [child('Slice one', true), child('Slice two', true)];
  const plain = child('Plain child', false);
  const land = (extra = {}) => merged(board, parent, { agentId: 'coordinator', commit: COMMIT, forced: 'landed by hand', waiveProof: 'test fixture', ...extra });
  const status = id => getItem(board, id).item_status;
  return { board, parent, slices, plain, land, status };
}

test('store.io-board-merged.compose-landing-withdraws-submitted-slices: clause 1: with composeLanding the parent\'s merge withdraws each submitted slice child with the landed-with-parent reason in the same write [C7,#2397]', t => {
  const f = setup(t);
  f.land({ composeLanding: true });
  assert.equal(getItem(f.board, f.parent).item_merged_commit, COMMIT);
  for (const id of f.slices) {
    assert.equal(f.status(id), 'withdrawn');
    assert.equal(getItem(f.board, id).item_withdrawn_reason, `landed with parent #${f.parent} at ${COMMIT.slice(0, 12)}`);
  }
  assert.equal(f.status(f.plain), 'submitted', 'a child that is not a slice is left alone');
});

test('store.io-board-merged.compose-landing-refused-merge-changes-no-slice: clause 2: a refused merge leaves every slice as it was [C7,#2397]', t => {
  const f = setup(t);
  assert.throws(() => merged(f.board, f.parent, { agentId: 'coordinator', commit: COMMIT, composeLanding: true }), error => typeof error.code === 'string');
  assert.equal(getItem(f.board, f.parent).item_merged_commit ?? null, null);
  for (const id of f.slices) assert.equal(f.status(id), 'submitted');
});

test('store.io-board-merged.compose-landing-off-leaves-slices: clause 3: without composeLanding the parent\'s merge leaves its slices as they are [C7,#2397]', t => {
  const f = setup(t);
  f.land();
  assert.equal(getItem(f.board, f.parent).item_merged_commit, COMMIT);
  for (const id of f.slices) assert.equal(f.status(id), 'submitted');
});
