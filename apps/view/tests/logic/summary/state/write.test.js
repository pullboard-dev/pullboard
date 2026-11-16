/** A view state read after any board write returns the new data, never the kept copy [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { projectState } from '../../../../src/io/serve.js';
import { viewProofSummary } from "../../../../src/logic/summary/state.js";
import { cellBoard } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../../../packages/store/tests/fixtures/cell.js';

/**
 * Writes covered, each followed by a read on the same open board: a new item filed from another
 * connection, with its event (dashboardNext), a lane hold (holds), a plain shout (shouts), a decision shout
 * (decisions), a raw verdict row with no event (items), and a raw event row with no store call (events). The control
 * read with no write keeps the derived fields.
 */
test('clause 3: every kind of board write shows in the next state read, and a read with no write keeps the fields [N26,C7]', t => {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile);
  const read = () => projectState(project.repo, { board });
  const first = read();
  const kept = read();
  assert.equal(kept.shouts, first.shouts, 'a read with no write reuses the kept fields');
  assert.equal(kept.dashboardNext, first.dashboardNext, 'a read with no write reuses the kept order');

  const other = openCellBoard(project.boardFile);
  const id = cellItem(other, { lane: 'web', title: 'Fresh after write', specIds: ['G1'], criterion: 'The fixture item is valid.', check: 'true',
    brief: 'Files:\n- web/fixture.js\nChange:\n- Keep the fixture valid.\nTest:\n- Fresh after write passes.' }).item_id;
  closeCellBoard(other);
  assert.ok(read().dashboardNext.includes(id), 'a new item shows in the build order');

  store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'fresh hold' });
  assert.ok(read().holds.some(hold => JSON.stringify(hold).includes('fresh hold')), 'a lane hold shows');

  store.shout(board, { from: 'coordinator', to: 'web', text: 'Fresh shout', lanes: ['coordinator', 'web'] });
  assert.ok(read().shouts.some(shout => shout.shout_text === 'Fresh shout'), 'a shout shows');

  store.shout(board, { from: 'coordinator', to: store.PERSON, text: 'Fresh question?', lanes: ['coordinator'], decision: true });
  assert.ok(read().decisions.some(ask => ask.shout_text === 'Fresh question?'), 'a decision for the person shows');

  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (?, 'coordinator', 'REJECT', 'TEST_FAILURE', 'fresh verdict', ?, ?, ?, ?)`).run(id, 'a'.repeat(40), 'b'.repeat(64), 'a'.repeat(40), new Date().toISOString());
  assert.match(JSON.stringify(read().items.find(item => item.id === id)), /fresh verdict/u, 'a verdict shows on its item');

  board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', 'shout', NULL, '{}')").run(new Date().toISOString());
  const newest = board.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id;
  assert.equal(read().events[0].event_id, newest, 'a raw event shows first in the activity');
});

test('the view proof summary leaves out the two lists only pullboard stats reads [N26]', () => {
  const summary = viewProofSummary({ total: 3, notesPerSubmit: [{ seat: 'web-1', notes: 1, submits: 0, notesPerSubmit: null }],
    workFreeReleases: [{ day: '2026-11-02', seat: 'web-1', reason: 'BLOCKED', count: 1 }], agents: [], bars: [], caught: [], flow: null });
  assert.deepEqual(Object.keys(summary).sort(), ['flow', 'total']);
});

test('the view state lists only the landings of the last 24 hours, each with its commit [N26]', t => {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile);
  const make = title => cellItem(board, { lane: 'web', title, specIds: ['G1'], criterion: 'The fixture item is valid.', check: 'true',
    brief: 'Files:\n- web/fixture.js\nChange:\n- Keep the fixture valid.\nTest:\n- ' + title + ' passes.' }).item_id;
  const recent = make('Landed an hour ago'), old = make('Landed long ago');
  const merge = (id, commit, at) => {
    board.db.prepare('UPDATE item SET item_merged_commit = ? WHERE item_id = ?').run(commit, id);
    board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', 'merged', ?, ?)").run(at, id, JSON.stringify({ commit }));
  };
  merge(old, 'a'.repeat(40), new Date(Date.now() - 3 * 86_400_000).toISOString());
  merge(recent, 'b'.repeat(40), new Date(Date.now() - 3_600_000).toISOString());
  // Each landing also carries the time of its first recording (#7763); this test reads which landings and their commits.
  assert.deepEqual(projectState(project.repo, { board }).dashboardLanded.map(({ id, commit }) => ({ id, commit })), [{ id: recent, commit: 'b'.repeat(40) }], 'the old landing is not listed; the recent one carries its commit');
});
