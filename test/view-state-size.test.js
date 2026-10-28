import { compactItemSummaries } from '../src/view-state-summary.js';
import { expandItemSummaries } from '../src/view-state-summary.js';
/** Authenticated native view projections stay bounded at the real board's scale [N26,A2]. */
import { events as readStatsEvents } from '../src/board.js';
import { counterProofStats as readStatsCounter } from '../src/proof-counter-read.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { atomic } from '../src/board-event-log.js';
import { serveApi } from '../src/api.js';
import { main } from '../src/cli.js';
import { proofStats } from '../src/stats.js';
import { ensureProofCounters } from '../src/proof-counters.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { fetchFresh } from './http-fixture.js';

/** Native read operations explicitly supplied to the statistics under test. */
const statsReadPorts = { events: readStatsEvents, counterProofStats: readStatsCounter };


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
  const fullStats = proofStats(board, { now }, statsReadPorts);
  /** Emulate loss of one private derived shard, matching the accepted old-counter cache fixture. */
  function forgetReport() { board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run('local:proof-stats:v2:report-summary'); }
  /** Rebuild only derived counters through the normal writer helper, preserving native history. */
  function rebuildReport() { ensureProofCounters(board); }

  let builds = 0;
  const api = await serveApi({ runCommand: main, projects: () => [{ root: box.repo, name: 'State scale fixture' }],
    now: () => now, onStateBuild: () => { builds += 1; } });
  t.after(() => api.close());
  const url = new URL(api.url);
  const headers = { 'x-pullboard-key': url.searchParams.get('k') };
  /** Request the real authenticated HTTP surface, retaining the wire byte count. */
  async function request(path, authorized = true, method = 'GET', extraHeaders = {}) {
    const response = await fetchFresh(url.origin + path, { method, headers: { ...(authorized ? headers : {}), ...extraHeaders } });
    const text = await response.text();
    return { status: response.status, bytes: Buffer.byteLength(text), document: text ? JSON.parse(text) : null, etag: response.headers.get('etag') };
  }
  const listing = await request('/api/v1/boards');
  assert.equal(listing.status, 200);
  const path = '/api/v1/boards/' + encodeURIComponent(listing.document.boards[0].id);
  return { request, path, agents, fullStats, forgetReport, rebuildReport, builds: () => builds, advance: ms => { now += ms; } };
}

test('[N26,A2] 1600 items, 1150 seats and 40000 shouts yield a sub-600KB authenticated state with complete summaries', async t => {
  const box = await fixture(t, { items: 1600, seats: 1150, shouts: 40_000 });
  assert.ok(Buffer.byteLength(JSON.stringify(box.fullStats)) > 1_000_000, 'the source contains real board-scale proof detail');
  const ordinary = await box.request(box.path + '/state');
  const wire = await box.request(box.path + '/state?items=compact');
  assert.equal(wire.status, 200);
  assert.ok(wire.bytes < 1_000_000, `authenticated state is ${wire.bytes} bytes`);
  const first = { ...wire, document: { ...wire.document, state: expandItemSummaries(wire.document.state) } };
  assert.deepEqual(first.document.state, ordinary.document.state, 'compact decoding preserves every original state and summary field');
  assert.equal(Object.hasOwn(ordinary.document.state, 'itemEncoding'), false, 'ordinary API response stays unchanged');
  assert.equal(first.document.state.items.length, 1600);
  const itemBytes = Buffer.byteLength(JSON.stringify({ items: wire.document.state.items, itemEncoding: wire.document.state.itemEncoding }));
  t.diagnostic(`authenticatedItemsIncludingDictionary=${itemBytes} bytes; ordinaryItems=${Buffer.byteLength(JSON.stringify(ordinary.document.state.items))} bytes; state=${wire.bytes} bytes; items=1600`);
  assert.ok(itemBytes < 250_000, `authenticated item summaries including dictionary are ${itemBytes} bytes`);

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
  const cached = await box.request(box.path + '/state?items=compact');
  assert.ok(cached.bytes < 1_000_000, 'a clock-only cache hit cannot restore detailed proof records');
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

test('[N26,A2] missing derived proof data is unavailable for a known item rather than a false unknown item', async t => {
  const box = await fixture(t);
  box.forgetReport();
  const unavailable = await box.request(box.path + '/proofs/1');
  assert.equal(unavailable.status, 400);
  assert.equal(unavailable.document.error.code, 'ITEM_NOT_AVAILABLE');
  assert.match(unavailable.document.error.message, /normal writable board command.*rebuild/u);
  assert.equal((await box.request(box.path + '/proofs/999')).status, 404, 'a truly absent item remains unknown even when reports are unavailable');
  box.rebuildReport();
  const restored = await box.request(box.path + '/proofs/1');
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.document.proof, box.fullStats.flow.report.items.find(item => item.id === 1));
});


test('[N26,A2] item detail loads on demand through the authenticated endpoint without restoring detail to summaries', async t => {
  const box = await fixture(t);
  const state = await box.request(box.path + '/state');
  const summary = state.document.state.items.find(item => item.id === 1);
  assert.ok(summary);
  for (const field of ['criterion', 'brief', 'history', 'thread', 'verdicts', 'commit', 'merged']) {
    assert.equal(Object.hasOwn(summary, field), false, field + ' remains outside the list summary');
  }
  assert.equal((await box.request(box.path + '/items/1', false)).status, 401);
  assert.equal((await box.request(box.path + '/items/999')).status, 404);
  assert.equal((await box.request(box.path + '/items/0')).status, 400);
  const detail = await box.request(box.path + '/items/1');
  assert.equal(detail.status, 200);
  assert.equal(detail.document.item.id, 1);
  assert.equal(detail.document.item.criterion, 'The specified behavior is observable.');
  assert.match(detail.document.item.brief, /web\/page\.js/u);
  assert.ok(detail.document.item.history.some(event => event.kind === 'add'));
  assert.ok(Array.isArray(detail.document.item.thread));
  const after = await box.request(box.path + '/state');
  assert.deepEqual(after.document.state.items, state.document.state.items, 'reading detail does not populate the list response');
});


test('[N26,A2] compact summaries roundtrip differing values, explicit nulls, Unicode and absent fields without shared defaults', () => {
  const state = { sequence: 7, items: [
    { id: 1, title: '一🙂', status: 'open', lane: 'web', claim: null, counts: { facts: 0, verdicts: 0 }, blockedBy: [], optional: undefined },
    { id: 2, title: 'Deux', status: 'open', lane: 'web', claim: null, counts: { facts: 0, verdicts: 0 }, blockedBy: [] },
    { id: 3, title: 'ثلاثة', status: 'claimed', lane: 'web', claim: { by: 'builder', until: '2026-10-28T00:00:00Z' }, counts: { facts: 1, verdicts: 0 }, blockedBy: [1] },
    { id: 4, title: 'Four', status: 'open', lane: 'api', claim: null, counts: { facts: 0, verdicts: 0 }, blockedBy: [] },
  ] };
  const before = JSON.stringify(state);
  const encoded = compactItemSummaries(state);
  assert.equal(encoded.itemEncoding.version, 1);
  const expanded = expandItemSummaries(JSON.parse(JSON.stringify(encoded)));
  assert.deepEqual(expanded, JSON.parse(before));
  assert.equal(JSON.stringify(state), before, 'packing does not mutate its source');
  expanded.items[0].blockedBy.push(99);
  expanded.items[0].counts.facts = 99;
  assert.deepEqual(expanded.items[1].blockedBy, []);
  assert.equal(expanded.items[1].counts.facts, 0, 'decoded rows do not share mutable defaults');
  assert.equal(expandItemSummaries(state), state, 'the default API and full snapshots need no decoding');
  assert.equal(compactItemSummaries({ items: [] }).items.length, 0);
  assert.throws(() => expandItemSummaries({ items: [], itemEncoding: { version: 2, defaults: {} } }), /unsupported compact/u);
  assert.throws(() => expandItemSummaries({ items: [{ title: 'Missing id' }], itemEncoding: { version: 1, defaults: {} } }), /invalid compact/u);
  assert.throws(() => expandItemSummaries({ items: [], itemEncoding: { version: 1, defaults: { id: 1 } } }), /unsupported compact/u);
});

test('[N26,A2] compact state preserves ordinary delta bases and rejects incompatible formats', async t => {
  const box = await fixture(t, { items: 4 });
  const ordinary = await box.request(box.path + '/state');
  const compact = await box.request(box.path + '/state?items=compact');
  assert.deepEqual(expandItemSummaries(compact.document.state), ordinary.document.state);
  assert.ok(ordinary.etag && compact.etag);
  assert.notEqual(compact.etag, ordinary.etag, 'different wire representations cannot share a conditional response validator');
  assert.equal((await box.request(box.path + '/state?items=compact', true, 'GET', { 'if-none-match': ordinary.etag })).status, 200);
  assert.equal((await box.request(box.path + '/state?items=compact', true, 'GET', { 'if-none-match': compact.etag })).status, 304);

  const delta = await box.request(box.path + '/state?since=' + compact.document.state.sequence);
  assert.equal(delta.status, 200);
  assert.ok(delta.document.delta);
  assert.deepEqual(delta.document.delta.merge, {});
  assert.equal(Object.hasOwn(delta.document.delta.replace, 'items'), false, 'compaction does not change canonical item delta fingerprints');
  for (const suffix of ['items=unknown', 'items=compact&detail=full', 'items=compact&since=0']) {
    assert.equal((await box.request(box.path + '/state?' + suffix)).status, 400, suffix);
  }
});
