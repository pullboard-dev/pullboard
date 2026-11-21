/** With composeLanding in its args, recording a parent's landing closes its submitted slices in the same write [C7,#2397]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { board_ensureCoordinator } from '../../../index.js';
import { getItem } from '../../../index.js';
import { merged } from '../../../index.js';
import { MERGED_AT_ENGINE } from '../../../../state/index.js';
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

/** A real repo with one commit and a board whose clock is ten minutes past it, with one open item to land by hand. */
function landing(t, engine) {
  const project = cellProject(t, { real: true });
  const later = () => new Date(Date.now() + 10 * 60 * 1000);
  const board = cellBoard(t, project.boardFile, { now: later }, { real: true, gitRoot: project.repo });
  board_ensureCoordinator(board, project.repo);
  if (engine !== undefined) board.executionEngineVersion = engine;
  const item = cellItem(board, { lane: 'web', title: 'Landed by hand', criterion: '1. It works [test]', route: 'strong', check: 'true' }).item_id;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project.repo, encoding: 'utf8' }).trim();
  const committedAt = Number(execFileSync('git', ['show', '-s', '--format=%ct', commit], { cwd: project.repo, encoding: 'utf8' }).trim()) * 1000;
  const land = (extra = { mergedAt: committedAt }) => merged(board, item, { agentId: 'coordinator', commit, forced: 'landed by hand', waiveProof: 'test fixture', ...extra });
  const event = () => board.db.prepare("SELECT event_at, event_detail FROM event WHERE event_kind = 'merged' AND item_id = ?").get(item);
  return { board, commit, committedAt, land, event };
}

test('store.merged.merged-at-commit-time: clause 1: at MERGED_AT_ENGINE the merged event carries the commit time as detail.mergedAt while event_at stays the record time [C7,#12225]', t => {
  const f = landing(t, MERGED_AT_ENGINE);
  f.land();
  const row = f.event();
  const detail = JSON.parse(row.event_detail);
  assert.equal(detail.mergedAt, f.committedAt, 'mergedAt is the commit\'s committer time in ms');
  assert.ok(Date.parse(row.event_at) - detail.mergedAt >= 9 * 60 * 1000, `event_at ${row.event_at} stays the record time, ten minutes after the commit`);
});

test('store.merged.merged-at-absent: clause 2: below MERGED_AT_ENGINE, or with no mergedAt or one that is not a safe integer, the event has no mergedAt key [C7,#12225]', t => {
  const old = landing(t, MERGED_AT_ENGINE - 1);
  old.land();
  assert.equal('mergedAt' in JSON.parse(old.event().event_detail), false, 'below the engine there is no mergedAt');
  const none = landing(t, MERGED_AT_ENGINE);
  none.land({});
  assert.equal('mergedAt' in JSON.parse(none.event().event_detail), false, 'no mergedAt passed leaves the key out');
  const bad = landing(t, MERGED_AT_ENGINE);
  bad.land({ mergedAt: 1.5 });
  assert.equal('mergedAt' in JSON.parse(bad.event().event_detail), false, 'a value that is not a safe integer leaves the key out');
});
