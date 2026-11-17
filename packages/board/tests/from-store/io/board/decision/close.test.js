/** @pullboard-test-input packages/state/src/logic/engines/ask-close-engine.js */
/** An open ask closes when its item lands or is withdrawn, and a one-time sweep closes the stale ones [B21,C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../../store/index.js';
import { submitFixture } from '../../../../../../store/tests/fixtures/submit.js';
import { cellBoard } from '../../../../fixtures/cell-board.js';
import { cellItem } from '../../../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../../store/tests/fixtures/cell.js';

const LANES = ['coordinator', 'web'];

/** A board with a builder, plus a way to file items and ask about them. */
function fixture(t) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  const builder = cellSeat(board, { lane: 'web', path: `${project.dir}/builder` }).id;
  const file = (title) => cellItem(board, { lane: 'web', title, criterion: 'Tracked work', specIds: ['G1'] }).item_id;
  const ask = (id, text = `#${id} needs an independent reviewer`) => store.shout(board, { from: 'coordinator', to: 'person', text, decision: true, lanes: LANES });
  const verify = (id) => {
    const commit = String(id).repeat(40).slice(0, 40);
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze: () => ({ text: 'Tracked work', digest: 'digest:tracked' }) });
    submitFixture(board, id, { agentId: builder, commit, tree: 'tree' });
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'checked it', head: commit, digest: 'digest:tracked', policy: 'any' });
  };
  const open = () => store.openDecisions(board).map(row => row.shout_id);
  const reply = (id) => board.db.prepare('SELECT shout_text FROM shout WHERE shout_answers=?').get(id)?.shout_text;
  return { board, builder, file, ask, verify, open, reply };
}

test('landing an item closes every open ask on it with that reason [B21,C7]', (t) => {
  const { board, builder, file, ask, verify, open, reply } = fixture(t);
  const id = file('Landed with asks');
  const other = file('Still open');
  verify(id);
  const direct = store.shout(board, { from: builder, to: 'coordinator', item: id, text: 'Which interface?', decision: true, options: ['one', 'two'], lanes: LANES });
  const lead = ask(id);
  const unrelated = ask(other);
  store.merged(board, id, { agentId: 'coordinator', commit: 'a'.repeat(40) });
  assert.deepEqual(open(), [unrelated], 'only the ask on the live item stays open');
  assert.match(reply(direct), /landed/u);
  assert.match(reply(lead), /^Closed: #\d+ landed$/u);
  assert.equal(store.openDecisions(board, 'coordinator').some(row => row.shout_id === direct), false);
});

test('withdrawing an item closes every open ask on it with the withdrawal reason [B21,C7]', (t) => {
  const { board, file, ask, open, reply } = fixture(t);
  const id = file('Withdrawn with asks');
  const lead = ask(id);
  store.withdraw(board, id, { agentId: 'coordinator', reason: 'duplicate of #5' });
  assert.deepEqual(open(), []);
  assert.match(reply(lead), /withdrawn: duplicate of #5/u);
});

test('the sweep closes asks already open on finished items once and never a live item\'s [B21,C7,H16]', (t) => {
  const { board, file, ask, verify, open, reply } = fixture(t);
  const landed = file('Landed first');
  const withdrawn = file('Withdrawn first');
  const live = file('Live');
  verify(landed);
  store.merged(board, landed, { agentId: 'coordinator', commit: 'b'.repeat(40) });
  store.withdraw(board, withdrawn, { agentId: 'coordinator', reason: 'not wanted' });
  // These asks were opened after their items finished, as the stale ones on the real board were.
  const late = [ask(landed), ask(withdrawn), ask(landed, `coordinator: #${landed} built, merged, NOT queued`)];
  const stays = ask(live);
  assert.deepEqual(open(), [...late, stays]);
  const closed = store.closeFinishedAsks(board, { agentId: 'coordinator' });
  assert.deepEqual(closed.sort((a, b) => a - b), late);
  assert.deepEqual(open(), [stays]);
  assert.match(reply(late[0]), /landed/u);
  assert.match(reply(late[1]), /withdrawn: not wanted/u);
  const events = store.events(board, {}).length;
  assert.deepEqual(store.closeFinishedAsks(board, { agentId: 'coordinator' }), [], 'a second sweep closes nothing');
  assert.equal(store.events(board, {}).length, events, 'and writes no event');
});
