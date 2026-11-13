/** The API serves each board's small summary at /summary and says so in its listing, so the view sidebar never downloads whole boards (A2, N26). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewApiPorts } from '../../../../view/index.js';
import { projectSummary } from '../../../../view/index.js';
import { apiHttpFixture } from '../../../tests/fixtures/api.js';
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';
import { main } from '../../../tests/fixtures/native.js';
import { refusalDocument } from '../../../index.js';
import { fetchFresh } from '../../../tests/fixtures/http.js';
import { serveApi } from '../../../../../packages/api/index.js';

const BRIEF = 'Files:\n- app/fixture.js\nChange:\n- Keep the fixture valid.\nTest:\n- the fixture case passes';

/** Serve one private board with the view's real ports, and a caller that reads and writes it over HTTP. */
async function served(t, viewPorts) {
  const box = apiHttpFixture(t);
  const api = await serveApi({ viewPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: box.root, name: 'HTTP fixture' }] });
  t.after(() => api.close());
  const url = new URL(api.url);
  const call = async (path, value) => {
    const response = await fetchFresh(url.origin + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'x-pullboard-key': url.searchParams.get('k'), ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, text: await response.text() };
  };
  const listed = JSON.parse((await call('/api/v1/boards')).text);
  return { call, listed, path: '/api/v1/boards/' + listed.boards[0].id };
}

test('[A2, N26] GET /boards/:id/summary answers the board\'s version 1 summary under 2 KB, and each listed board offers it [#6634]', async (t) => {
  const { call, listed, path } = await served(t, { ...viewApiPorts, projectSummary });
  for (const row of listed.boards) assert.equal(row.summaryVersion, 1, 'every listed board offers its summary');
  const added = await call(path + '/moves', { verb: 'add', args: { lane: 'app', title: 'Summary item', criterion: 'complete', specs: 'G1', brief: BRIEF } });
  assert.equal(added.status, 200, added.text);
  const read = await call(path + '/summary');
  assert.equal(read.status, 200, read.text);
  assert.ok(Buffer.byteLength(read.text) < 2048, 'the whole reply is under 2 KB');
  const body = JSON.parse(read.text).summary;
  assert.equal(JSON.parse(read.text).version, undefined);
  assert.equal(body.version, 1);
  for (const key of ['sequence', 'building', 'awaiting', 'sentBack', 'open', 'verified', 'decisions', 'pending', 'drafts', 'holds', 'lastChange']) assert.ok(Object.hasOwn(body, key), key);
  assert.equal(body.open, 1);
  // The same numbers the page reduces from the board's own state.
  const state = JSON.parse((await call(path + '/state')).text).state;
  assert.deepEqual(body, projectSummary(state, state.needs));
});

test('[A2] a POST to the summary path is refused as BAD_REQUEST, and a server without the projection lists no summaryVersion [#6634]', async (t) => {
  const { call, listed, path } = await served(t, viewApiPorts);
  assert.equal(listed.boards[0].summaryVersion, undefined);
  const post = await call(path + '/summary', {});
  assert.equal(post.status, 400);
  assert.equal(JSON.parse(post.text).error.code, 'BAD_REQUEST');
});
