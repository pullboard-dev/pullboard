/** @pullboard-test-gui */
/** @pullboard-test-input source-cell apps/cli apps/lib store */
/** The real cockpit fixture reads close API and stylesheet connections [N38,C7]. */
import assert from 'node:assert/strict';
import diagnosticsChannel from 'node:diagnostics_channel';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  machine,
  project,
  startView,
  styleOf,
  boardId,
} from '../../../tests/fixtures/cockpit/harness.js';

test('[N38,C7] real cockpit fixture reads close API and stylesheet connections', async (t) => {
  const box = machine();
  const fixtureProject = project(box, 'wire proof');
  const channel = diagnosticsChannel.channel('undici:client:sendHeaders');
  const sent = [];
  let origin = null;
  /** Record the headers Undici is actually about to send to this fixture's view origin. */
  function recordHeaders({ request: outgoing, headers }) {
    if (origin && String(outgoing?.origin) === origin) sent.push({ path: outgoing.path, headers: String(headers) });
  }
  const httpChannel = diagnosticsChannel.channel('http.client.request.start');
  /** Observe node:http requests at the same wire boundary without depending on a client transport. */
  function recordHttpHeaders({ request: outgoing }) {
    if (!origin || 'http://' + outgoing.getHeader('host') !== origin) return;
    const headers = Object.entries(outgoing.getHeaders()).map(([name, value]) => `${name}: ${value}`).join('\r\n');
    sent.push({ path: outgoing.path, headers });
  }
  channel.subscribe(recordHeaders);
  httpChannel.subscribe(recordHttpHeaders);
  let view;
  try {
    view = await startView(box);
    origin = new URL(view.base).origin;
    await styleOf(view);
    assert.notEqual(await boardId(view, fixtureProject.repo), 'not-registered');
  } finally {
    channel.unsubscribe(recordHeaders);
    httpChannel.unsubscribe(recordHttpHeaders);
    await view?.stop();
  }
  const closes = (request) => /(?:^|\r?\n)connection:\s*close(?:\r?\n|$)/iu.test(request.headers);
  assert.ok(sent.some((request) => request.path.startsWith('/view.css') && closes(request)),
    'the real stylesheet request sends Connection: close');
  assert.ok(sent.some((request) => request.path.startsWith('/api/v1/boards') && closes(request)),
    'the real API listing request sends Connection: close');
});
