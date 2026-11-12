import { viewApiPorts } from '../../../view/index.js';
/** Private cost cohorts, native model names and statistically honest comparisons [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import { createLocalApiHandler } from '../../../../packages/api/index.js';
import { main } from '../../tests/fixtures/native.js';
import { refusalDocument } from '../../index.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { costAnalytics } from '../../../../packages/stats/index.js';
import { wilson } from '../../../../packages/stats/index.js';

const presentation = model => ({ key: model.toLowerCase(), name: model, vendor: 'Fixture' });
/** Build a board's ordered item, verdict and usage events. */
function seeded(groups) {
  const items = [], agents = [], events = [];
  let sequence = 0, id = 0;
  const event = (kind, item, by, detail = {}) => events.push({ event_id: ++sequence, event_kind: kind, item_id: item, event_by: by, event_at: '2026-10-30T12:00:00.000Z', event_detail: JSON.stringify(detail) });
  for (const [model, count, returns] of groups) for (let index = 0; index < count; index++) {
    id++; const builder = `b${id}`, verifier = `v${id}`;
    items.push({ item_id: id, item_title: `Item ${id}` });
    agents.push({ agent_id: builder, model }, { agent_id: verifier, model: 'Reviewer' });
    event('submit', id, builder);
    if (index < returns) { event('reject', id, verifier); event('submit', id, builder); }
    event('accept', id, verifier);
    event('usage', null, builder, { item: id, revision: 1, records: [{ model, wallMs: 1000, inputTokens: 10 }] });
    event('merged', id, 'coordinator');
  }
  return { items, agents, events, window: 'today', now: new Date('2026-10-30T14:00:00Z'), timeZone: 'UTC', modelPresentation: presentation };
}

test('native landing cohorts, duration, unknowns and Wilson score remain consistent [N26]', () => {
  const input = seeded([['Alpha', 30, 0], ['Beta', 30, 20]]);
  const result = costAnalytics(input);
  assert.equal(result.totals.agentMs, 60000);
  assert.equal(result.totals.medianItemMs, 1000);
  assert.deepEqual(result.totals.sentBack, { items: 20, itemShare: 1 / 3, agentMs: 20000, agentMsShare: 1 / 3 });
  assert.deepEqual(result.days, [{ date: '2026-10-30', firstTimeMs: 40000, sentBackMs: 20000, items: 60 }]);
  assert.equal(result.builders.verdict, 'clear');
  assert.equal(result.builders.best, 'alpha');
  assert.equal(result.verifiers.rows[0].verdicts, 80);
  assert.equal(result.longest[0].sessions[0].count, 1, 'a model line counts its recorded usage records');
  const interval = wilson(5, 10);
  assert.ok(Math.abs(interval.low - 0.236593) < 0.00001);
  assert.ok(Math.abs(interval.high - 0.763407) < 0.00001);
});

test('model comparison distinguishes overlapping, small and single qualified cohorts [N26]', () => {
  assert.equal(costAnalytics(seeded([['A', 30, 3], ['B', 30, 4]])).builders.verdict, 'leaning');
  const one = costAnalytics(seeded([['A', 30, 3], ['B', 4, 0]])).builders;
  assert.equal(one.verdict, 'nothing-to-compare');
  assert.equal(one.rows.find(row => row.model === 'b').tooFew, true);
  assert.equal(one.rows.find(row => row.model === 'b').low, null);
});

test('shared or absent usage remains unknown and windows honor local day boundaries [N26]', () => {
  const input = seeded([['A', 1, 0]]);
  input.events.find(event => event.event_kind === 'usage').event_detail = JSON.stringify({ item: 1, revision: 1, shared: true, records: [] });
  const result = costAnalytics({ ...input, timeZone: 'America/Chicago' });
  assert.equal(result.from, '2026-10-30T05:00:00.000Z');
  assert.equal(result.totals.agentMs, null);
  assert.equal(result.totals.medianItemMs, null);
  assert.equal(result.longest.length, 0);
});

test('a later seat model change never relabels an earlier submission [N26]', () => {
  const input = seeded([['Old', 1, 0]]);
  input.agents.find(agent => agent.agent_id === 'b1').model = 'New';
  input.events.push({ event_id: 1000, event_kind: 'model', event_by: 'b1', event_detail: JSON.stringify({ model: 'New' }) });
  const result = costAnalytics(input);
  assert.equal(result.unknownBuilderModelShare, 1);
  assert.equal(result.builders.rows.length, 0);
});


test('private local endpoint serves analytics and refuses hosted origins and missing credentials [N26]', async t => {
  const box = apiHttpFixture(t);
  let port;
  const handler = createLocalApiHandler({ viewPorts: viewApiPorts, runCommand: main, secret: 'fixture-secret', getPort: () => port, projects: () => [{ root: box.root, name: 'fixture' }], boardOpeners: apiBoardOpeners, refusalDocument, costModelPresentation: presentation, allowedOrigins: ['https://app.pullboard.dev'] });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(() => new Promise(resolve => { handler.close(); server.close(resolve); server.closeIdleConnections(); }));
  const base = `http://127.0.0.1:${port}`, headers = { 'x-pullboard-key': 'fixture-secret' };
  const boards = await (await fetchFresh(base + '/api/v1/boards', { headers })).json();
  const path = '/api/v1/boards/' + boards.boards[0].id + '/cost-analytics?window=7d';
  const response = await fetchFresh(base + path, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).costAnalytics.window, '7d');
  assert.notEqual((await fetchFresh(base + path, { headers: { ...headers, origin: 'https://app.pullboard.dev' } })).status, 200);
  assert.notEqual((await fetchFresh(base + path)).status, 200);
});


test('recorded event model survives later seat relabeling [N26]', () => {
  const input = seeded([['Old', 1, 0]]);
  input.events.find(event => event.event_kind === 'submit').event_detail = JSON.stringify({ model: 'Old' });
  input.agents.find(agent => agent.agent_id === 'b1').model = 'New';
  input.events.push({ event_id: 1000, event_kind: 'model', event_by: 'b1', event_detail: JSON.stringify({ model: 'New' }) });
  const result = costAnalytics(input);
  assert.equal(result.builders.rows[0].model, 'old');
  assert.equal(result.unknownBuilderModelShare, 0);
});


test('a seeded native board yields actual cohorts, Wilson bounds and verdicts [N26]', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-cost-cohort-'));
  const board = openBoard(':memory:');
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  const coordinator = store.register(board, { lane: 'coordinator', path: dir });
  const alpha = store.register(board, { lane: 'core', path: join(dir, 'alpha'), model: 'Alpha' });
  const beta = store.register(board, { lane: 'core', path: join(dir, 'beta'), model: 'Beta' });
  const verifier = store.register(board, { lane: 'review', path: join(dir, 'verifier'), model: 'Reviewer' });
  const at = new Date('2026-10-30T12:00:00Z');
  for (let index = 0; index < 60; index++) {
    const builder = index < 30 ? alpha : beta, model = index < 30 ? 'Alpha' : 'Beta';
    const id = store.addItem(board, { by: coordinator, lane: 'core', title: `Seeded ${index}` });
    logEvent(board, builder, 'submit', id, {}, at);
    if (index >= 30 && index < 50) { logEvent(board, verifier, 'reject', id, {}, at); logEvent(board, builder, 'submit', id, {}, at); }
    logEvent(board, verifier, 'accept', id, {}, at);
    logEvent(board, builder, 'usage', null, { item: id, revision: 1, records: [{ model, wallMs: 1000, inputTokens: 10 }] }, at);
    logEvent(board, coordinator, 'merged', id, {}, at);
  }
  const result = costAnalytics({ items: store.listItems(board), agents: store.listAgents(board), events: store.events(board), window: 'today', now: new Date('2026-10-30T14:00:00Z'), timeZone: 'UTC', modelPresentation: presentation });
  assert.equal(result.totals.itemCount, 60);
  assert.equal(result.totals.agentMs, 60000);
  assert.equal(result.totals.sentBack.items, 20);
  assert.equal(result.builders.verdict, 'clear');
  assert.equal(result.builders.best, 'alpha');
  const betaRow = result.builders.rows.find(row => row.model === 'beta');
  assert.deepEqual({ low: betaRow.low, high: betaRow.high }, wilson(10, 30));
  assert.equal(result.verifiers.rows[0].accepts, 60);
});
