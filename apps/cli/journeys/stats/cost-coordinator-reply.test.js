/** The real cost-analytics reply carries the coordinator's recorded usage, and unknown when none is recorded [C7,#10111]. @pullboard-test-input source-cell apps/cli packages/api packages/stats packages/store */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { viewApiPorts } from '../../../view/index.js';
import { createLocalApiHandler } from '../../../../packages/api/index.js';
import * as store from '../../../../packages/store/index.js';
import { refusalDocument } from '../../index.js';
import { apiFetch } from '../../tests/fixtures/api.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** The model name the recorded coordinator session reports. */
const SESSION_MODEL = ['fixture', 'coordinator'].join('-');

/** Serve the board through the real local API handler, with no stand-in for the coordinator usage reader, and read its cost-analytics reply. */
async function costReply(t, box) {
  const secret = randomUUID();
  let port = 0;
  const handler = createLocalApiHandler({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret, getPort: () => port,
    runCommand: async () => { throw new Error('this journey only reads'); }, projects: () => [{ root: box.root, name: 'Cost fixture', project: '', added: '2026-01-01T00:00:00.000Z' }],
    costModelPresentation: model => ({ key: model, name: model, vendor: null }) });
  const server = createServer(handler);
  await new Promise((done, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); }); });
  t.after(async () => { handler.close(); const closed = new Promise(done => server.close(done)); server.closeAllConnections(); await closed; });
  const api = { origin: `http://127.0.0.1:${port}`, secret };
  const listed = await (await apiFetch(api, '/api/v1/boards')).json();
  const response = await apiFetch(api, `/api/v1/boards/${encodeURIComponent(listed.boards[0].id)}/cost-analytics?window=30d`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).costAnalytics;
}

test('clause 1: the real cost-analytics reply carries the coordinator usage the board recorded, so the overview shows it [C7,#10111]', async t => {
  const box = await fixture(t);
  store.recordCoordinatorUsage(box.board, { session: 'coordinator-session-1', observedAt: 5, records: [{ model: SESSION_MODEL, inputTokens: 10, outputTokens: 4,
    knownInputTokens: 10, knownOutputTokens: 4, wallMs: 0, freshInputTokens: 3, cacheReadInputTokens: 5, cacheWriteInputTokens: 2, unknownReasons: [] }] });
  const { coordinator } = await costReply(t, box);
  assert.equal(coordinator.sessions, 1);
  assert.equal(coordinator.inputTokens, 10);
  assert.equal(coordinator.outputTokens, 4);
  assert.deepEqual(coordinator.models, [SESSION_MODEL]);
});

test('clause 1: with no coordinator data the real reply still carries an entry that reads unknown, not zero [C7,#10111]', async t => {
  const box = await fixture(t);
  const { coordinator } = await costReply(t, box);
  assert.equal(coordinator.sessions, 0);
  assert.equal(coordinator.inputTokens, null);
  assert.equal(coordinator.outputTokens, null);
});
