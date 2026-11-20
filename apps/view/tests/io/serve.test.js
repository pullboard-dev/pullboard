/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/activity.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/io/shouts.css apps/view/src/io/notch.css */
/** The view's page answers a browser that accepts brotli with a 200 and brotli content, not a 500 [N26]. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { test } from 'node:test';
import { serveView } from '../../src/io/serve.js';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';

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

test('view.serve.no-link-local-says-run-pullboard-view: clause 3: a loopback browser GET of the root page with no key or cookie gets 401 saying to run pullboard view, with no secret or board data [N26]', async (t) => {
  const secret = ['serve', 'test', 'key', '9876543210'].join('-');
  const none = () => { throw new Error('not used without a key'); };
  const view = await serveView({
    secret,
    runCommand: none,
    renderPage: () => 'BOARD-DATA-MARKER',
    refusalDocument: () => '',
    boardOpeners: { openBoard: none, openBoardForRead: none },
  });
  t.after(() => view.close());
  const answer = await get(view.port, '/', { accept: 'text/html' });
  const page = answer.body.toString('utf8');
  assert.equal(answer.status, 401, 'no key, no page');
  assert.match(page, /Run <code>pullboard view<\/code> in a terminal on this machine/u, 'the page says how to open the board');
  assert.doesNotMatch(page, /Ask the person who shared/u, 'the owner is not sent to someone else');
  assert.ok(!page.includes(secret) && !page.includes('BOARD-DATA-MARKER') && !/[?&]k=/u.test(page), 'no secret, link or board data in the page');
});

test('view.io-serve.compat-cells: clause 1: GET /compat-cells answers the compat cells of the root runs file as JSON, one node run showing its run id, read only [C7]', async (t) => {
  const root = cellProject(t, { real: true, gate: 'true' }).repo;
  mkdirSync(join(root, '.pullboard', 'conformance'), { recursive: true });
  writeFileSync(join(root, '.pullboard', 'conformance', 'runs.json'), JSON.stringify([
    { id: 'run-node-1', language: 'node', at: '2026-11-20T10:00:00Z', stages: { claim: 'works' } },
  ]));
  const secret = ['serve', 'test', 'key', '5566778899'].join('-');
  const none = () => { throw new Error('not used by compat cells'); };
  const view = await serveView({
    secret,
    projectRoot: root,
    projects: () => [{ root, name: 'Compat fixture' }],
    runCommand: none,
    renderPage: () => '',
    refusalDocument: () => '',
    boardOpeners: { openBoard: none, openBoardForRead: none },
  });
  t.after(() => view.close());
  const answer = await get(view.port, '/compat-cells', { 'x-pullboard-key': secret });
  assert.equal(answer.status, 200);
  const groups = JSON.parse(answer.body.toString('utf8'));
  assert.deepEqual(groups.map((group) => group.stage), ['claim', 'submit', 'gate', 'review', 'accept', 'land']);
  assert.deepEqual(groups[0].cells.find((cell) => cell.language === 'node'), { language: 'node', outcome: 'works', run: 'run-node-1' });
  const post = await new Promise((done, fail) => {
    const outbound = request({ host: '127.0.0.1', port: view.port, path: '/compat-cells', method: 'POST', agent: false, headers: { connection: 'close', 'x-pullboard-key': secret } }, (response) => { response.resume(); response.on('end', () => done(response.statusCode)); });
    outbound.once('error', fail);
    outbound.end();
  });
  assert.notEqual(post, 200, 'only a read is answered');
});
