import { viewApiPorts } from '../../../../view/index.js';
/** Person requests stay open until answered and their messages enter the event log (A2). */
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { createLocalApiHandler } from '../../../../../packages/api/index.js';
import { refusalDocument } from '../../../index.js';
import { main } from '../../../tests/fixtures/native.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fetchFresh } from '../../../tests/fixtures/http.js';

/** Make a real throwaway SQLite board with a coordinator and one lane agent. */
function boardFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-api-requests-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const board = openBoard(join(directory, 'board.sqlite'));
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
    shout: answer, to: 'person', decision: false, request: false, answers: request, outcome: 'done', model: 'unknown',
  });
  assert.deepEqual(afterAnswer.slice(-2).map((event) => event.event_id), [requestEvent.event_id, answerEvent.event_id]);
  assert.equal(store.getShout(board, answer).shout_answers, request);
});


test("the API passes blank shout text to the CLI's own refusal [A2,A9]", async (t) => {
  const e2e = createE2eHelpers();
  let handler;
  let server;
  t.after(async () => {
    handler?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolveClosed => server.close(resolveClosed));
    }
    e2e.cleanup();
  });
  const box = e2e.project('true');
  const secret = randomUUID();
  let port = 0;
  handler = createLocalApiHandler({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument,
    secret, getPort: () => port, runCommand: main,
    projects: () => [{ root: box.repo, name: 'Shout fixture', project: '', added: '2026-01-01T00:00:00.000Z' }],
  });
  server = createServer(handler);
  await new Promise((resolveReady, rejectReady) => {
    server.once('error', rejectReady);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolveReady();
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const headers = { 'x-pullboard-key': secret, 'content-type': 'application/json' };
  const boardsResponse = await fetchFresh(`${origin}/api/v1/boards`, { headers });
  assert.equal(boardsResponse.status, 200);
  const boards = await boardsResponse.json();
  const board = boards.boards.find(entry => entry.root === box.repo);
  assert.ok(board);
  /** Send the actual authenticated HTTP move, retaining status and the public refusal document. */
  async function move(body) {
    const response = await fetchFresh(`${origin}/api/v1/boards/${board.id}/moves`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, document: await response.json() };
  }
  for (const text of ['', '  \t\n ']) {
    const cli = await box.runLocal(box.repo, 'shout', 'web', text, '--json');
    assert.notEqual(cli.code, 0);
    const expected = JSON.parse(cli.out).error;
    assert.equal(expected.code, 'EMPTY_SHOUT');
    assert.ok(expected.next);
    for (const args of [{ to: 'web', text }, { text }]) {
      const api = await move({ verb: 'shout', args });
      assert.equal(api.document.error?.code, 'EMPTY_SHOUT', `blank ${JSON.stringify(args)} reaches the CLI refusal`);
      assert.equal(api.status, 409);
      assert.deepEqual(api.document.error, expected, 'the API preserves the CLI message and next step');
    }
  }
  for (const body of [
    { verb: 'shout', args: { to: 'web' } },
    ...[null, 42, [], {}].map(text => ({ verb: 'shout', args: { to: 'web', text } })),
    { verb: 'shout', args: { to: '', text: 'Hello' } },
    { verb: 'shout', args: { to: 42, text: 'Hello' } },
    { verb: 'shout', args: null },
    { verb: 'shout', args: [] },
    { verb: 'shout', args: { to: 'web', text: 'Hello', extra: true } },
    { verb: 'shout', item: 1, args: { to: 'web', text: 'Hello' } },
    { verb: 'shout', args: { to: 'web', text: 'Hello' }, extra: true },
  ]) {
    const api = await move(body);
    assert.equal(api.status, 400, JSON.stringify(body));
    assert.equal(api.document.error.code, 'BAD_REQUEST', JSON.stringify(body));
    assert.ok(api.document.error.next);
  }
  const success = await move({ verb: 'shout', args: { to: 'web', text: 'Keep this valid message.' } });
  assert.equal(success.status, 200);
  assert.equal(success.document.event.event_kind, 'shout');
  const inbox = await box.runLocal(box.web, 'inbox', '--json');
  assert.equal(inbox.code, 0, inbox.err || inbox.out);
  assert.deepEqual(JSON.parse(inbox.out).shouts.map(row => row.shout_text), ['Keep this valid message.']);
});

test('the API refuses incomplete native board providers before discovery or commands [A2,C7,D3]', () => {
  let discoveries = 0;
  let commands = 0;
  const options = {
    refusalDocument,
    secret: randomUUID(),
    getPort: () => 0,
    /** A refused provider must not reach the real command boundary. */
    runCommand: async () => { commands++; return 0; },
    /** No repository or board discovery is permitted before provider validation. */
    projects: () => { discoveries++; return []; },
  };
  for (const boardOpeners of [undefined, {}, { openBoard: apiBoardOpeners.openBoard }, { openBoardForRead: apiBoardOpeners.openBoardForRead }]) {
    assert.throws(() => createLocalApiHandler({ viewPorts: viewApiPorts, ...options, boardOpeners }), /actual native board openers/u);
  }
  assert.deepEqual({ discoveries, commands }, { discoveries: 0, commands: 0 });
});
