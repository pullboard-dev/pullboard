/** A seat with board.url set posts its heartbeat through POST /moves and reports a refusal as not held [P7]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { sendRemoteHeartbeat } from '../../../src/io/remote/moves.js';

test('cli.io-remote-moves.heartbeat-posts-the-move: sendRemoteHeartbeat posts {verb: heartbeat, args: {}, agent} to the fixture server /moves and reports a refusal as not held [P7,B3]', async (t) => {
  const posts = [];
  let refuse = false;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (part) => { body += part; });
    request.on('end', () => {
      posts.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(refuse ? 409 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(refuse ? { error: { code: 'NOT_HELD', message: 'this seat holds no claim' } } : { result: {} }));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const remote = { url: `http://127.0.0.1:${server.address().port}/api/v1/boards/b1`, token: 'k', agent: 'core-9' };
  assert.equal(await sendRemoteHeartbeat(remote), true);
  assert.deepEqual(posts, [{ path: '/api/v1/boards/b1/moves', body: { verb: 'heartbeat', args: {}, agent: 'core-9' } }]);
  refuse = true;
  assert.equal(await sendRemoteHeartbeat(remote), false, 'a refused beat reads as not held');
});
