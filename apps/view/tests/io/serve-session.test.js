/** @pullboard-test-input apps/view/src/io/serve.js apps/view/src/io/serve-session.js */
/** The view's session cookie derives from its secret, so a restarted view with the same secret accepts the first one's cookie [#613,#11056]. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { serveView } from '../../src/io/serve.js';
import { apiBoardOpeners } from '../../../cli/tests/fixtures/board.js';

/** One real GET against a running view; resolves status and headers. */
function get(port, path, headers = {}) {
  return new Promise((done, fail) => {
    const outbound = request({ host: '127.0.0.1', port, path, agent: false, headers: { connection: 'close', ...headers } }, (response) => {
      response.resume();
      response.on('end', () => done({ status: response.statusCode ?? 0, headers: response.headers }));
    });
    outbound.once('error', fail);
    outbound.end();
  });
}

/** A view on the given secret that stops with the test. */
async function view(t, secret) {
  const none = () => { throw new Error('not used by a page load'); };
  const served = await serveView({ secret, runCommand: none, renderPage: () => '<p>ok</p>', refusalDocument: () => ({}), boardOpeners: apiBoardOpeners });
  t.after(() => served.close());
  return served;
}

/** The name=value cookie the first view sets when a request carries its secret. */
async function firstCookie(t, secret) {
  const first = await view(t, secret);
  const answer = await get(first.port, `/?k=${secret}`);
  assert.equal(answer.status, 303);
  const cookie = String(answer.headers['set-cookie']).split(';')[0];
  await first.close();
  return cookie;
}

const SECRET = ['session', 'cookie', 'test', '0123456789'].join('-');

test('view.serve-session.same-secret-accepts-cookie: clause 1: a restarted view with the same secret answers 200 to the cookie the first one set, with no ?k= [C7,#613]', async (t) => {
  const cookie = await firstCookie(t, SECRET);
  const second = await view(t, SECRET);
  const answer = await get(second.port, '/', { cookie });
  assert.equal(answer.status, 200);
});

test('view.serve-session.other-secret-refuses-cookie: clause 2: a view started with a different secret refuses that cookie as it refuses no cookie [C7,#613]', async (t) => {
  const cookie = await firstCookie(t, SECRET);
  const other = await view(t, SECRET + '-other');
  const withCookie = await get(other.port, '/', { cookie });
  const without = await get(other.port, '/');
  assert.equal(withCookie.status, 403);
  assert.equal(withCookie.status, without.status);
});

test('view.serve-session.real-path: clause 3: the cookie comes from a real HTTP response of serveView, so the derivation under test is the one serveView uses [C7,#613]', async (t) => {
  const cookie = await firstCookie(t, SECRET);
  assert.match(cookie, /^pullboard_view_[0-9a-f]{18}=[A-Za-z0-9_-]{43}$/u);
});
