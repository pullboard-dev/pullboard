/** A queued gate's captured main is replaced by the newest main through the board's write path, and a gate not queued refuses [C7,H16,#9819]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem } from '../../../../index.js';
import { completeSubmitHandoff } from '../../../../index.js';
import { claim } from '../../../../index.js';
import { register } from '../../../../index.js';
import { submitHandoff } from '../../../../index.js';
import { writeBoardCommand } from '../../../../index.js';
import { recordSubmitHandoff } from '../../../../../jobs/index.js';
import { BOARD_RELEASE_CODES_ENGINE } from '../../../../../state/index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';

const MINUTE = 60_000;
const OLD = 'a'.repeat(40);
const NEWEST = 'b'.repeat(40);

/** One claimed item whose gate is queued at an old main; the board closes with the test. */
function queued(t, state = 'queued') {
  const board = fixtureBoard(t);
  register(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = register(board, { lane: 'core', path: '/builder', route: 'strong' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Recapture fixture', route: 'strong' });
  claim(board, id, { agentId: builder, lane: 'core', leaseMs: MINUTE, freeze: item => ({ text: item.item_title, digest: 'd'.repeat(64) }) });
  recordSubmitHandoff(board.db, id, { version: 1, id: 'job-1', agentId: builder, commit: 'c'.repeat(40), main: OLD, digest: 'd'.repeat(64), state });
  return { board, builder, id };
}

test('store.io-submit-handoff-retry.recapture-replaces-main: clause 1: writeBoardCommand for recaptureSubmitHandoff replaces a queued hand-off\'s captured main with the newest main and records the move [C7,H16]', t => {
  const { board, builder, id } = queued(t);
  const events = () => board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id=? AND event_kind='submit-handoff'").get(id).n;
  const before = events();
  const written = writeBoardCommand(board, 'recaptureSubmitHandoff', [id, { agentId: builder, job: 'job-1', main: NEWEST }], builder);
  assert.equal(written.job.main, NEWEST);
  assert.equal(submitHandoff(board, id).main, NEWEST);
  assert.equal(submitHandoff(board, id).state, 'queued');
  assert.equal(submitHandoff(board, id).commit, 'c'.repeat(40), 'only the captured main changes');
  assert.equal(events(), before + 1, 'the move is recorded');
});

test('store.io-submit-handoff-retry.recapture-needs-queued: clause 2: a hand-off that is not queued, or a job the sender does not own, refuses SUBMIT_HANDOFF_CHANGED and writes nothing [C7,H16]', t => {
  const { board, builder, id } = queued(t, 'running');
  const events = () => board.db.prepare('SELECT COUNT(*) AS n FROM event WHERE item_id=?').get(id).n;
  const before = events();
  assert.throws(() => writeBoardCommand(board, 'recaptureSubmitHandoff', [id, { agentId: builder, job: 'job-1', main: NEWEST }], builder), { code: 'SUBMIT_HANDOFF_CHANGED' });
  assert.throws(() => writeBoardCommand(board, 'recaptureSubmitHandoff', [id, { agentId: builder, job: 'job-other', main: NEWEST }], builder), { code: 'SUBMIT_HANDOFF_CHANGED' });
  assert.equal(submitHandoff(board, id).main, OLD);
  assert.equal(events(), before);
});

/** A queued gate that finishes refused with returnToBoard set, at the given engine; the item's release events come back. */
function refusedToBoard(t, engine) {
  const { board, builder, id } = queued(t, 'running');
  board.executionEngineVersion = engine;
  completeSubmitHandoff(board, id, { agentId: builder, job: 'job-1', returnToBoard: true,
    result: { code: 1, error: { code: 'GATE_RED', message: 'the gate is red', next: 'fix it' } } });
  const item = board.db.prepare('SELECT item_status, item_owner FROM item WHERE item_id=?').get(id);
  const releases = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='release'").all(id).map(row => JSON.parse(row.event_detail));
  return { item, releases };
}

const REFUSED_TEXT = 'the queued gate was refused (GATE_RED); returned to the board for any free seat';

test('store.handoff-retry.gate-refused-code: clause 1: at the board-release-codes engine a refused queued gate returned to the board leaves the item open with no owner and a release event coded GATE_REFUSED with the reason text unchanged [C7,#12220]', t => {
  const { item, releases } = refusedToBoard(t, BOARD_RELEASE_CODES_ENGINE);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_owner, null);
  assert.equal(releases.length, 1, JSON.stringify(releases));
  assert.equal(releases[0].reasonCode, 'GATE_REFUSED');
  assert.equal(releases[0].reason, REFUSED_TEXT);
});

test('store.handoff-retry.gate-refused-code-below-engine: clause 2: below the board-release-codes engine the same release still carries OTHER with the same text [C7,#12220]', t => {
  const { item, releases } = refusedToBoard(t, BOARD_RELEASE_CODES_ENGINE - 1);
  assert.equal(item.item_status, 'open');
  assert.equal(releases.length, 1, JSON.stringify(releases));
  assert.equal(releases[0].reasonCode, 'OTHER');
  assert.equal(releases[0].reason, REFUSED_TEXT);
});
