/** A pull-mode submit records one submit_offered event for the gate job it offers, and none for a job already open [C7]. */
// fixture-subject: addItem (the submit_offered event is recorded against an item the board holds)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { fixtureBoard } from '../../fixtures/board.js';
import { recordSubmitOffered } from '../../../src/io/submit/offered.js';

const COMMIT = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);

test('cli.submit-offered.event-once: recordSubmitOffered appends exactly one submit_offered event by the submitting agent and nothing for a job it already recorded [C7]', t => {
  const board = fixtureBoard(t);
  const item = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Offers once', brief: 'Files: web/a.html' });
  const rows = () => board.db.prepare("SELECT event_by, item_id, event_detail FROM event WHERE event_kind = 'submit_offered' ORDER BY event_id").all();
  assert.equal(recordSubmitOffered(board, { item, by: 'web-1', commit: COMMIT, job: `gate:${item}:aaaaaaaaaaaa:x`, main: MAIN }), true);
  assert.equal(rows().length, 1, 'one event for the new job');
  assert.equal(rows()[0].event_by, 'web-1');
  assert.equal(rows()[0].item_id, item);
  assert.deepEqual(JSON.parse(rows()[0].event_detail), { commit: COMMIT, job: `gate:${item}:aaaaaaaaaaaa:x`, main: MAIN });
  assert.equal(recordSubmitOffered(board, { item, by: 'web-1', commit: COMMIT, job: `gate:${item}:aaaaaaaaaaaa:x`, main: MAIN }), false);
  assert.equal(rows().length, 1, 'the job already recorded as offered appends nothing');
  recordSubmitOffered(board, { item, by: 'web-1', commit: COMMIT, job: `gate:${item}:cccccccccccc:y`, main: MAIN });
  assert.equal(rows().length, 2, 'a new job for a new candidate appends its own event');
});
