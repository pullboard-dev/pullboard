/** Person requests stay open until answered and their messages enter the event log (A2). */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';

/** Make a real throwaway SQLite board with a coordinator and one lane agent. */
function boardFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-api-requests-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const board = store.openBoard(join(directory, 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: join(directory, 'repo') });
  store.register(board, { lane: 'app', path: join(directory, 'app-1') });
  return board;
}

/** Add one message's declared lanes for the fixture board. */
const lanes = ['coordinator', 'app'];

test('[A2] a request stays open after inbox read, while ordinary decisions keep their lifecycle', (t) => {
  const board = boardFor(t);
  const request = store.shout(board, {
    from: 'person', to: 'coordinator', text: 'Approve the API row', lanes, request: true,
  });
  const decision = store.shout(board, {
    from: 'app-1', to: 'coordinator', text: 'May I change the contract?', lanes, decision: true,
  });

  const firstInbox = store.inbox(board, 'coordinator');
  assert.deepEqual(firstInbox.map((message) => message.shout_id), [request, decision]);
  assert.deepEqual(store.openRequests(board).map((message) => message.shout_id), [request]);
  assert.deepEqual(store.openDecisions(board).map((message) => message.shout_id), [decision]);
  assert.deepEqual(store.inbox(board, 'coordinator').map((message) => message.shout_id), [request], 'open requests are prepended again after the unread cursor advances');
  assert.deepEqual(store.openRequests(board).map((message) => message.shout_id), [request], 'reading does not close the request');

  store.shout(board, {
    from: 'coordinator', to: 'person', text: 'done', lanes, answers: request,
  });
  assert.deepEqual(store.openRequests(board), [], 'the request closes only when the coordinator answers');
  assert.deepEqual(store.openDecisions(board).map((message) => message.shout_id), [decision], 'answering a request does not answer an ordinary decision');
  store.shout(board, {
    from: 'coordinator', to: 'app-1', text: 'Yes, keep the change within the approved row.', lanes, answers: decision,
  });
  assert.deepEqual(store.openDecisions(board), []);
});

test('[A2] only the coordinator may decline a request, and a decline needs a reason', (t) => {
  const board = boardFor(t);
  const request = store.shout(board, {
    from: 'person', to: 'coordinator', text: 'Approve the API row', lanes, request: true,
  });
  const countBefore = board.db.prepare('SELECT COUNT(*) AS count FROM shout').get().count;
  const eventsBefore = store.events(board).length;

  assert.throws(() => store.shout(board, {
    from: 'coordinator', to: 'person', text: 'declined', lanes, answers: request,
  }), (error) => error.code === 'REQUEST_OUTCOME');
  assert.throws(() => store.shout(board, {
    from: 'app-1', to: 'person', text: 'declined because it is out of scope', lanes, answers: request,
  }), (error) => error.code === 'COORDINATOR_ONLY');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS count FROM shout').get().count, countBefore);
  assert.equal(store.events(board).length, eventsBefore);
  assert.deepEqual(store.openRequests(board).map((message) => message.shout_id), [request]);

  const reply = store.shout(board, {
    from: 'coordinator', to: 'person', text: 'declined because it is out of scope', lanes, answers: request,
  });
  assert.equal(store.getShout(board, reply).shout_request_outcome, 'declined');
  assert.equal(store.getShout(board, reply).shout_text, 'declined because it is out of scope');
  assert.deepEqual(store.openRequests(board), []);
});

test('[A2] successful shouts and answers each append their corresponding event', (t) => {
  const board = boardFor(t);
  const baseline = store.events(board).length;
  const request = store.shout(board, {
    from: 'person', to: 'coordinator', text: 'Approve the API row', lanes, request: true,
  });
  const afterRequest = store.events(board);
  const requestEvent = afterRequest.at(-1);
  assert.equal(afterRequest.length, baseline + 1);
  assert.equal(requestEvent.event_by, 'person');
  assert.equal(requestEvent.event_kind, 'shout');
  assert.deepEqual(JSON.parse(requestEvent.event_detail), {
    shout: request, to: 'coordinator', decision: false, request: true, answers: null,
  });

  const answer = store.shout(board, {
    from: 'coordinator', to: 'person', text: 'done', lanes, answers: request,
  });
  const afterAnswer = store.events(board);
  const answerEvent = afterAnswer.at(-1);
  assert.equal(afterAnswer.length, baseline + 2);
  assert.equal(answerEvent.event_by, 'coordinator');
  assert.equal(answerEvent.event_kind, 'answer');
  assert.deepEqual(JSON.parse(answerEvent.event_detail), {
    shout: answer, to: 'person', decision: false, request: false, answers: request, outcome: 'done',
  });
  assert.deepEqual(afterAnswer.slice(-2).map((event) => event.event_id), [requestEvent.event_id, answerEvent.event_id]);
  assert.equal(store.getShout(board, answer).shout_answers, request);
});
