/** An unexpected error behind the board API is answered as a generic SERVICE_ERROR and its stack is logged [A2,C7]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApiHandler } from '../../index.js';
import { fetchFresh } from '../../../../apps/cli/tests/fixtures/http.js';
import { writeFileSync } from 'node:fs';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../store/tests/fixtures/cell.js';
import { boardId } from '../../../store/index.js';
import { openBoardForRead } from '../../../store/index.js';
import { serveApi } from '../../index.js';

/** The renderer the API takes as a port: a refusal becomes its public error body. */
function refusalDocument(error) {
  return { error: { code: error.code ?? 'INTERNAL', message: String(error.message) } };
}

test('clause 1: a thrown TypeError behind the real HTTP service is logged with its stack while the body stays the generic SERVICE_ERROR [A2,C7]', async (t) => {
  const logged = [];
  t.mock.method(process.stderr, 'write', (chunk) => { logged.push(String(chunk)); return true; });
  const handler = createApiHandler({ refusalDocument,
    authenticate: () => ({ user: 'fixture-user' }),
    board: (id) => ({ id }),
    stateJson: () => { throw new TypeError('fixture state serializer exploded'); },
    eventLogVersion: () => 'v1',
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const response = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/fixture/state?seen=1');
  const text = await response.text();
  assert.equal(response.status, 500);
  assert.equal(JSON.parse(text).error.code, 'SERVICE_ERROR');
  assert.equal(text.includes('exploded'), false, 'the response body does not leak the original message');
  assert.equal(text.includes('TypeError'), false, 'the response body does not leak the stack');
  const log = logged.join('');
  assert.match(log, /TypeError: fixture state serializer exploded/u, 'the original message is logged');
  assert.match(log, /\n\s+at /u, 'the stack is logged');
});

/** The board openers the higher composition root hands the API, over the store's own fixture board. */
const OPENERS = Object.freeze({ openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] });

/** Serve the board API over the given registered projects and read one board's events by id. */
async function readEvents(t, projects, id) {
  const secret = 'fixture-secret';
  const api = await serveApi({ projects: () => projects, secret, runCommand: async () => 0, isMain: false, refusalDocument, boardOpeners: OPENERS });
  t.after(() => api.close());
  const response = await fetchFresh(`http://127.0.0.1:${api.port}/api/v1/boards/${id}/events?k=${secret}`);
  return { status: response.status, body: await response.json() };
}

/** The persistent id of a fixture project's board. */
function fixtureBoardId(project) {
  const board = openCellBoard(project.boardFile);
  try { return boardId(board); } finally { closeCellBoard(board); }
}

test('clause 1 [P7]: a registered board that cannot be read is logged with its code, message and board id, and the refusal names the read failure instead of NO_BOARD (#6158)', async (t) => {
  const project = cellProject(t);
  const id = fixtureBoardId(project);
  writeFileSync(project.boardFile, 'this is not a SQLite database, so every read of the board fails\n'.repeat(64));
  const logged = [];
  t.mock.method(process.stderr, 'write', (chunk) => { logged.push(String(chunk)); return true; });
  const answer = await readEvents(t, [{ root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-12' }], id);
  assert.notEqual(answer.body.error?.code, 'NO_BOARD', JSON.stringify(answer.body));
  assert.equal(answer.body.error?.code, 'BOARD_UNAVAILABLE', JSON.stringify(answer.body));
  assert.match(answer.body.error.message, /could not be read/u, 'the refusal names the read failure');
  assert.ok(answer.body.error.message.includes(project.repo), 'the refusal names the unreadable board');
  const line = logged.join('').split('\n').find((entry) => entry.startsWith('pullboard: board read failed'));
  assert.ok(line, `the read failure is logged: ${logged.join('')}`);
  assert.ok(line.includes(`board ${id}`), 'the log line carries the asked board id');
  assert.match(line, /: \S+ \S/u, 'the log line carries the error code and message');
  assert.match(line, /not a database|SQLITE|file/iu, 'the log line carries the underlying SQLite error');
});

test('clause 1 [P7]: a board id no registered board carries still answers NO_BOARD when every board reads (#6158)', async (t) => {
  const project = cellProject(t);
  fixtureBoardId(project);
  const logged = [];
  t.mock.method(process.stderr, 'write', (chunk) => { logged.push(String(chunk)); return true; });
  const answer = await readEvents(t, [{ root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-12' }], 'no-such-board');
  assert.equal(answer.status, 404, JSON.stringify(answer.body));
  assert.equal(answer.body.error.code, 'NO_BOARD');
  assert.equal(logged.join('').includes('board read failed'), false, 'a readable board logs no read failure');
});
