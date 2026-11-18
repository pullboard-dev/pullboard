/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/activity.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/io/shouts.css apps/view/src/io/notch.css */
/** The view's page answers a browser that accepts brotli with a 200 and brotli content, not a 500 [N26]. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { brotliDecompressSync } from 'node:zlib';
import { test } from 'node:test';
import { serveView } from '../../src/io/serve.js';

/** One GET on its own connection; the body is returned as bytes so a compressed answer stays intact. */
function get(port, path, headers) {
  return new Promise((done, fail) => {
    const outbound = request({ host: '127.0.0.1', port, path, agent: false, headers: { connection: 'close', ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => done({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outbound.once('error', fail);
    outbound.end();
  });
}

test('serve.page.brotli-answers-200: clause 2: a page GET with Accept-Encoding br answers 200 with brotli content [N26]', async (t) => {
  const secret = ['serve', 'test', 'key', '0123456789'].join('-');
  const none = () => { throw new Error('not used by a page GET'); };
  const view = await serveView({
    secret,
    runCommand: none,
    renderPage: () => '<!doctype html><title>Pullboard</title>',
    refusalDocument: () => '',
    boardOpeners: { openBoard: none, openBoardForRead: none },
  });
  t.after(() => view.close());
  const answer = await get(view.port, '/', { 'x-pullboard-key': secret, accept: 'text/html', 'accept-encoding': 'br' });
  assert.equal(answer.status, 200, 'a brotli-accepting page GET answers 200');
  assert.equal(answer.headers['content-encoding'], 'br', 'the page is brotli encoded');
  assert.equal(brotliDecompressSync(answer.body).toString('utf8'), '<!doctype html><title>Pullboard</title>', 'the brotli body is the page');
});
