/** An unexpected error behind the board API is answered as a generic SERVICE_ERROR and its stack is logged [A2,C7]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApiHandler } from '../../index.js';
import { fetchFresh } from '../../../../apps/cli/tests/fixtures/http.js';

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
