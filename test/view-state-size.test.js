/** Authenticated native view projections stay bounded at the real board's scale [N26,A2]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { atomic } from '../src/board-event-log.js';
import { serveApi } from '../src/api.js';
import { main } from '../src/cli.js';
import { proofStats } from '../src/stats.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { fetchFresh } from './http-fixture.js';

/** Initialize an actual Git/SQLite project and expose a controlled observation clock over HTTP. */
async function fixture(t, { items = 1, seats = 1, shouts = 0, recentAge = 0 } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  let now = Date.now() + 8 * 3_600_000;
  let at = now - 8 * 3_600_000;
  // @pullboard-board-file journey: the API and actual moves share the private CLI-initialized board.
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'), { now: () => new Date(at) });
  t.after(() => store.closeBoard(board));
  const agents = [];
  atomic(board, () => {
    for (let index = 0; index < seats; index += 1) agents.push(store.register(board, {
      lane: 'web', path: join(box.dir, `seat-${index}`), model: 'Fixture model', family: 'Fixture vendor',
    }));
    for (let index = 0; index < items; index += 1) store.addItem(board, {
      by: 'coordinator', lane: 'web', title: `Scale item ${index}`, criterion: 'The specified behavior is observable.',
      check: 'true', brief: 'Files: web/page.js\nTest: the specified behavior is observable.', specIds: ['G1'],
    });
    for (let index = 0; index < shouts; index += 1) store.shout(board, {
      from: agents[index % agents.length], to: 'coordinator', text: `Recorded activity ${index}`, lanes: ['web', 'api'],
    });
  });
  at = now - recentAge;
  store.shout(board, { from: agents[0], to: 'coordinator', text: 'Recently active seat', lanes: ['web', 'api'] });
  const fullStats = proofStats(board, { now });
  let builds = 0;
  const api = await serveApi({ runCommand: main, projects: () => [{ root: box.repo, name: 'State scale fixture' }],
    now: () => now, onStateBuild: () => { builds += 1; } });
  t.after(() => api.close());
  const url = new URL(api.url);
  const headers = { 'x-pullboard-key': url.searchParams.get('k') };
  /** Request the real authenticated HTTP surface, retaining the wire byte count. */
  async function request(path, authorized = true, method = 'GET') {
    const response = await fetchFresh(url.origin + path, { method, headers: authorized ? headers : {} });
    const text = await response.text();
    return { status: response.status, bytes: Buffer.byteLength(text), document: JSON.parse(text) };
  }
  const listing = await request('/api/v1/boards');
  assert.equal(listing.status, 200);
  const path = '/api/v1/boards/' + encodeURIComponent(listing.document.boards[0].id);
  return { request, path, agents, fullStats, builds: () => builds, advance: ms => { now += ms; } };
}

test('[N26,A2] 1600 items, 1150 seats and 40000 shouts yield a sub-600KB authenticated state with complete summaries', async t => {
  const box = await fixture(t, { items: 1600, seats: 1150, shouts: 40_000 });
  assert.ok(Buffer.byteLength(JSON.stringify(box.fullStats)) > 1_000_000, 'the source contains real board-scale proof detail');
  const first = await box.request(box.path + '/state');
  assert.equal(first.status, 200);
  assert.ok(first.bytes < 600_000, `authenticated state is ${first.bytes} bytes`);
  assert.equal(first.document.state.items.length, 1600);
  const state = first.document.state;
  assert.deepEqual(state.agents.map(agent => agent.agent_id), [box.agents[0]]);
  assert.equal(state.agents[0].model, 'Fixture model');
  assert.equal(state.agents[0].agent_family, 'Fixture vendor');
  assert.ok(state.agents[0].displayName);
  assert.equal(state.proofStats.agentCount, box.fullStats.agentCount, 'all-time totals do not become active-only totals');
  for (const key of ['submissions', 'rejections', 'rejectionShare', 'merged', 'mergedWithoutAccept', 'firstEventAt', 'lastEventAt']) {
    assert.deepEqual(state.proofStats[key], box.fullStats[key], key);
  }
  for (const key of ['stages', 'queues', 'unreviewed', 'activeAgents', 'bottleneck']) {
    assert.deepEqual(state.proofStats.flow[key], box.fullStats.flow[key], key);
  }
  for (const key of ['overall', 'lanes', 'milestones', 'scope']) {
    assert.deepEqual(state.proofStats.flow.report[key], box.fullStats.flow.report[key], key);
  }
  assert.equal(Object.hasOwn(state.proofStats.flow.report, 'items'), false);
  const detail = await box.request(box.path + '/proofs/1');
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.document.proof, box.fullStats.flow.report.items.find(item => item.id === 1));
  box.advance(1);
  const cached = await box.request(box.path + '/state');
  assert.ok(cached.bytes < 600_000, 'a clock-only cache hit cannot restore detailed proof records');
  assert.equal(Object.hasOwn(cached.document.state.proofStats.flow.report, 'items'), false);
  assert.equal(box.builds(), 1, 'summary shaping survives the existing dynamic flow cache path');
  t.diagnostic(`state=${first.bytes} bytes; fullProofStats=${Buffer.byteLength(JSON.stringify(box.fullStats))} bytes`);
});

test('[N26,A2] active-seat expiry rebuilds the cached state at the inclusive four-hour boundary and retains a three-hour-old seat', async t => {
  const box = await fixture(t, { recentAge: 3 * 3_600_000 });
  assert.equal((await box.request(box.path + '/state')).document.state.agents.length, 1);
  box.advance(3_600_000);
  assert.equal((await box.request(box.path + '/state')).document.state.agents.length, 1);
  box.advance(1);
  const expired = await box.request(box.path + '/state');
  assert.deepEqual(expired.document.state.agents, []);
  assert.equal(expired.document.state.proofStats.flow.activeAgents.total, 0);
  assert.equal(box.builds(), 2);
});

test('[N26,A2] detailed proof reads retain board authentication and reject missing, malformed and write requests', async t => {
  const box = await fixture(t);
  assert.equal((await box.request(box.path + '/proofs/1', false)).status, 401);
  assert.equal((await box.request(box.path + '/proofs/999')).status, 404);
  assert.equal((await box.request(box.path + '/proofs/0')).status, 400);
  assert.equal((await box.request(box.path + '/proofs/1', true, 'POST')).status, 400);
  assert.equal((await box.request(box.path + '/proofs/1')).status, 200);
});
