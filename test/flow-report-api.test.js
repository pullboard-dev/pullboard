/** Stable API validation retains recorded flow facts and native clock boundaries [A2,R1,R2]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalApiHandler } from '../src/api.js';
import { refusalDocument } from '../src/next-step-words.js';
import * as store from '../src/board.js';
import { logEvent } from '../src/board-event-log.js';
import { main } from '../src/cli.js';
import { apiFetch } from './api-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

/** Serve an isolated real Git/SQLite board through the production local adapter. */
async function apiFixture(t) {
  const box = fixtures.project('true');
  const secret = randomUUID();
  let port = 0;
  const handler = createLocalApiHandler({ refusalDocument, secret, getPort: () => port, runCommand: main,
    projects: () => [{ root: box.repo, name: 'Flow validator', project: '', added: '2026-01-01T00:00:00Z' }], stateDetail: 'summary' });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const api = { secret, origin: `http://127.0.0.1:${port}` };
  const listing = await (await apiFetch(api, '/api/v1/boards')).json();
  const path = `/api/v1/boards/${listing.boards[0].id}/state`;
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { isMain: true });
  t.after(() => store.closeBoard(board));
  return { api, path, board };
}

/** Append controlled lifecycle evidence through the native counter-maintaining writer. */
function event(board, id, kind, detail, at = Date.now()) {
  logEvent(board, kind === 'reserve' || kind === 'accept' ? 'review-1' : 'web-1', kind, id, detail, new Date(at));
}

test('flow report polls ignore only observation increments and retain claim and reservation expiry [A2,R1,R2]', async t => {
  const { api, path, board } = await apiFixture(t);
  const claim = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Claim clock' });
  const review = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Review clock' });
  const now = Date.now(), until = now + 2500, commit = 'a'.repeat(40);
  event(board, claim, 'claim', { leaseUntil: new Date(until).toISOString() }, now);
  event(board, review, 'claim', { leaseUntil: new Date(now + 60_000).toISOString() }, now - 1000);
  event(board, review, 'submit', { commit }, now - 500);
  event(board, review, 'reserve', { until: new Date(until + 2500).toISOString() }, now);
  const first = await apiFetch(api, path), initial = await first.json();
  const tag = first.headers.get('etag'), token = first.headers.get('x-pullboard-report-validator');
  assert.match(token, /^[a-f0-9]{64}:[0-9]+$/u);
  assert.equal(Object.hasOwn(initial, 'reportValidator'), false, 'transport metadata does not change public JSON');
  await delay(30);
  const current = await (await apiFetch(api, path)).json();
  assert.notDeepEqual(current.state.proofStats.flow.report, initial.state.proofStats.flow.report, 'public durations continue advancing');
  const deltaPath = path + '?since=' + initial.state.sequence;
  const stableDelta = await apiFetch(api, deltaPath);
  assert.equal(stableDelta.headers.get('x-pullboard-report-validator'), token, 'delta and full reads share stable report material');
  assert.ok((await stableDelta.json()).delta);
  assert.equal((await apiFetch(api, path, { headers: { 'if-none-match': tag } })).status, 304);
  await delay(Math.max(0, until - Date.now() + 30));
  const expiredClaim = await apiFetch(api, path, { headers: { 'if-none-match': tag } });
  assert.equal(expiredClaim.status, 200, 'a real claim boundary invalidates the report validator');
  const claimTag = expiredClaim.headers.get('etag'), claimToken = expiredClaim.headers.get('x-pullboard-report-validator');
  assert.notEqual(claimToken, token);
  assert.equal((await apiFetch(api, deltaPath)).headers.get('x-pullboard-report-validator'), claimToken);
  await expiredClaim.json();
  await delay(Math.max(0, until + 2500 - Date.now() + 30));
  const expiredReview = await apiFetch(api, path, { headers: { 'if-none-match': claimTag } });
  assert.equal(expiredReview.status, 200, 'a real reservation boundary invalidates it again');
  assert.notEqual(expiredReview.headers.get('x-pullboard-report-validator'), claimToken);
});

test('completed flow durations and captured submission sizes remain validator material [A2,R1,R2]', async t => {
  const { api, path, board } = await apiFixture(t);
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Recorded duration and size' });
  const now = Date.now(), commit = 'b'.repeat(40);
  event(board, id, 'claim', { leaseUntil: new Date(now + 120_000).toISOString() }, now);
  const before = await apiFetch(api, path);
  const oldTag = before.headers.get('etag'), oldToken = before.headers.get('x-pullboard-report-validator');
  const oldState = await before.json();
  event(board, id, 'submit', { commit, submissionSize: { base: 'c'.repeat(40), head: commit, lines: 150, method: 'added-plus-deleted-no-renames' } }, now + 60_000);
  event(board, id, 'reserve', { until: new Date(now + 120_000).toISOString() }, now + 60_000);
  event(board, id, 'accept', { commit }, now + 60_001);
  const changed = await apiFetch(api, path, { headers: { 'if-none-match': oldTag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('x-pullboard-report-validator'), oldToken);
  const changedDelta = await apiFetch(api, path + '?since=' + oldState.state.sequence);
  assert.equal(changedDelta.headers.get('x-pullboard-report-validator'), changed.headers.get('x-pullboard-report-validator'));
  assert.equal(Object.hasOwn(await changedDelta.json(), 'reportValidator'), false);
  const report = (await changed.json()).state.proofStats.flow.report;
  assert.equal(report.overall.sizeBuckets['100to300'].accepted, 1);
  assert.equal(report.items.find(item => item.id === id).stages.build.minutes, 1);
  assert.equal((await apiFetch(api, path, { headers: { 'if-none-match': changed.headers.get('etag') } })).status, 304, 'completed facts stay stable between new events');
});
