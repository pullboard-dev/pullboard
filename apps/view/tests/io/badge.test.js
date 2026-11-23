/** The items badge counts every landed item once, and the agent-verified percentage stays over the verified ones [B3,V1,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../packages/board/tests/fixtures/cell-board.js';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';
import { badgeCounts } from '../../src/io/badge.js';
import { badgeDocuments } from '../../src/io/badge.js';

/** One item row with the status, builder, commit and merge commit the badge reads. */
function addItem(board, { status, builtBy = null, commit = null, merged = null }) {
  const at = '2026-11-22T12:00:00.000Z';
  return Number(board.db.prepare(`INSERT INTO item (item_lane, item_title, item_status, item_built_by, item_commit, item_merged_commit, item_created_by, item_created_at, item_updated_at)
    VALUES ('app', 'Badge fixture', ?, ?, ?, ?, 'coordinator', ?, ?)`).run(status, builtBy, commit, merged, at, at).lastInsertRowid);
}

/** An ACCEPT verdict on the item's commit, with its assurance recorded as the board records it. */
function accept(board, item, { by, commit, assurance = 'independent' }) {
  const id = Number(board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (?, ?, 'ACCEPT', 'ok', ?, 'digest', ?, '2026-11-22T12:00:00.000Z')`).run(item, by, commit, commit).lastInsertRowid);
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run('verdict_assurance:' + id, assurance);
}

test('view.io-badge.items-badge-counts-landed-items: clause 1: the items badge counts an item landed with a merge commit as well as a verified one, once each, and the agent-verified percentage stays over the verified items [B3,V1,N26]', t => {
  const project = cellProject(t, { real: true, gate: 'true' });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  // The fixture board stands for a long-lived one whose items landed by hand, folded or withdrawn as on main; its state
  // machine's triggers would refuse to write those rows directly, so they go for this private temporary file.
  for (const { name } of board.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'item'").all()) board.db.exec(`DROP TRIGGER ${name}`);
  const checked = addItem(board, { status: 'verified', builtBy: 'builder', commit: 'c1', merged: 'm1' });
  accept(board, checked, { by: 'reviewer', commit: 'c1' });
  const selfChecked = addItem(board, { status: 'verified', builtBy: 'builder', commit: 'c2' });
  accept(board, selfChecked, { by: 'builder', commit: 'c2' });
  addItem(board, { status: 'open', merged: 'm3' });
  addItem(board, { status: 'withdrawn', merged: 'm4' });
  addItem(board, { status: 'open' });
  addItem(board, { status: 'open', merged: '' });

  const counts = badgeCounts(board);
  assert.deepEqual(counts, { items: 4, verified: 2, checked: 1, percent: 50 },
    'the verified item with a merge commit counts once; the hand-landed and withdrawn-as-on-main items count; unmerged items do not');
  const documents = Object.fromEntries(badgeDocuments(counts).map(document => [document.path, JSON.parse(document.text).message]));
  assert.deepEqual(documents, { 'docs/badges/items.json': '4 items', 'docs/badges/checked.json': '50%' });
  assert.deepEqual(badgeDocuments({ items: 3, verified: 0, checked: 0, percent: null }).map(document => document.path), ['docs/badges/items.json'],
    'with nothing verified there is no percentage to publish');
});
