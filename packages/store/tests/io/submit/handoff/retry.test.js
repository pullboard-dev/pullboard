/** A queued gate's captured main is replaced by the newest main through the board's write path, and a gate not queued refuses [C7,H16,#9819]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem } from '../../../../index.js';
import { claim } from '../../../../index.js';
import { register } from '../../../../index.js';
import { submitHandoff } from '../../../../index.js';
import { writeBoardCommand } from '../../../../index.js';
import { recordSubmitHandoff } from '../../../../../jobs/index.js';
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
