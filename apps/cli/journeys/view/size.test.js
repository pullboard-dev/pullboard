import { viewApiPorts } from '../../../view/index.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { compactItemSummaries } from '../../../view/index.js';
import { expandItemSummaries } from '../../../view/index.js';
/** Authenticated native view projections stay bounded at the real board's scale [N26,A2]. */
import { events as readStatsEvents } from '../../../../packages/store/index.js';
import { counterProofStats as readStatsCounter } from '../../../../packages/verify/index.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { addMilestone } from '../../../../packages/store/index.js';
import { atomic } from '../../../../packages/store/index.js';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { main } from '../../tests/fixtures/native.js';
import { proofStats } from '../../../../packages/stats/index.js';
import { ensureProofCounters } from '../../../../packages/verify/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fetchFresh } from '../../tests/fixtures/http.js';

/** Native read operations explicitly supplied to the statistics under test. */
const statsReadPorts = { events: readStatsEvents, counterProofStats: readStatsCounter };


/** Generate distinct ordinary work titles without copying any real board content. */
function generatedTitle(index) {
  const verbs = ['Retain', 'Validate', 'Render', 'Load', 'Record', 'Resolve', 'Preserve', 'Explain'];
  const areas = ['the state reader', 'review evidence', 'the roadmap', 'queued requests', 'item details', 'summary counters', 'native history'];
  const contexts = ['after an accepted main move', 'when a lease expires', 'on a cache hit', 'after a retry', 'for a changed milestone'];
  return `${verbs[index % verbs.length]} ${areas[index % areas.length]} ${contexts[index % contexts.length]} (generated ${index})${index % 19 === 0 ? ' — café 一🙂' : ''}`;
}

/** Seed varied native lifecycle data; synthetic submissions describe state, not an executed gate. */
function seedVariedItems(board, ids, agents, now, setAt) {
  for (let group = 0; group < 12; group += 1) addMilestone(board, {
    agentId: 'coordinator', reason: 'Arrange fixture release', name: `Generated milestone ${group}`, note: 'Generated size fixture only',
    items: ids.filter((id, index) => index % 7 !== 0 && index % 12 === group),
  });
  ids.forEach((id, index) => {
    let at = now - 2 * 3_600_000 + index * 3_001;
    setAt(at);
    const held = index >= ids.length - 16;
    const builder = agents[held ? 64 + index % 16 : index % 64];
    const reviewer = agents[(index + 4) % 64];
    const lane = ['web', 'api', 'core', 'docs'][index % 4];
    const kind = index % 20;
    const digest = `digest:generated-size-${id}`;
    if (held || kind < 14 || kind === 15 || kind === 16) {
      store.claim(board, id, { agentId: builder, lane, leaseMs: 3_600_000,
        freeze: item => ({ text: item.item_criterion, digest }) });
      if (!held) {
        setAt(at += 137);
        submitFixture(board, id, { agentId: builder, commit: 'a'.repeat(40), tree: `tree:generated-size-${id}` });
        if (kind !== 16) {
          setAt(at += 239);
          store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', head: 'a'.repeat(40), digest,
            policy: 'any', note: 'Generated state fixture only; no gate execution is claimed.' });
          if (kind < 14) { setAt(at += 347); store.merged(board, id, { agentId: 'coordinator', commit: 'b'.repeat(40) }); }
        }
      }
    } else if (kind === 14) store.withdraw(board, id, { agentId: 'coordinator', reason: 'Generated retired-work fixture' });
    for (let count = 0; count < index % 9; count += 1) {
      setAt(at += 53);
      store.appendFact(board, id, { agentId: builder, kind: 'note', text: `Generated observation ${count} for item ${id}; fixture data only.` });
    }
  });
}

/** Initialize an actual Git/SQLite project and expose a controlled observation clock over HTTP. */
async function fixture(t, { items = 1, seats = 1, shouts = 0, recentAge = 0, varied = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  let now = Date.now() + 8 * 3_600_000;
  let at = now - 8 * 3_600_000;
  // @pullboard-board-file journey: the API and actual moves share the private CLI-initialized board.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), { now: () => new Date(at) });
  t.after(() => store.closeBoard(board));
  const agents = [], ids = [];
  const lanes = ['web', 'api', 'core', 'docs'];
  atomic(board, () => {
    for (let index = 0; index < seats; index += 1) agents.push(store.register(board, {
      lane: varied ? lanes[index % lanes.length] : 'web', path: join(box.dir, `seat-${index}`), model: 'Fixture model', family: 'Fixture vendor',
    }));
    for (let index = 0; index < items; index += 1) {
      if (varied) at = now - 14 * 86_400_000 + index * 307_123;
      ids.push(store.addItem(board, {
        by: 'coordinator', lane: varied ? lanes[index % lanes.length] : 'web',
        title: varied ? generatedTitle(index) : `Scale item ${index}`, criterion: 'The specified behavior is observable.',
        check: 'true', brief: 'Files: web/page.js\nTest: the specified behavior is observable.',
        specIds: varied ? [['C7'], ['N26'], ['A2'], ['C7', 'N26']][index % 4] : ['G1'],
      }));
    }
    if (varied) seedVariedItems(board, ids, agents, now, value => { at = value; });
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
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: box.repo, name: 'State scale fixture' }],
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
  assert.ok(wire.bytes < 600_000, `authenticated state is ${wire.bytes} bytes`);
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
  assert.ok(cached.bytes < 600_000, 'a clock-only cache hit cannot restore detailed proof records');
  assert.equal(Object.hasOwn(cached.document.state.proofStats.flow.report, 'items'), false);
  assert.equal(box.builds(), 1, 'summary shaping survives the existing dynamic flow cache path');
  t.diagnostic(`state=${first.bytes} bytes; fullProofStats=${Buffer.byteLength(JSON.stringify(box.fullStats))} bytes`);
});

test('[N26,A2] varied generated native items use at most 40 percent of ordinary item bytes with the whole saving retained', async t => {
  const box = await fixture(t, { items: 1849, seats: 1150, shouts: 40_000, varied: true });
  const ordinary = await box.request(box.path + '/state');
  const wire = await box.request(box.path + '/state?items=compact');
  assert.equal(ordinary.status, 200);
  assert.equal(wire.status, 200);
  const rows = ordinary.document.state.items;
  assert.equal(rows.length, 1849);
  for (const key of ['lane', 'status', 'milestone']) assert.ok(new Set(rows.map(row => row[key])).size >= 4, key + ' genuinely varies');
  for (const key of ['updatedAt', 'since']) assert.ok(new Set(rows.map(row => row[key])).size > 1500, key + ' uses distinct native timestamps');
  assert.ok(new Set(rows.map(row => JSON.stringify(row.counts))).size >= 9, 'fact and verdict counts genuinely vary');
  assert.ok(new Set(rows.map(row => row.claim?.by).filter(Boolean)).size >= 8, 'distinct live holders are represented');
  const ordinaryBytes = Buffer.byteLength(JSON.stringify({ items: rows }));
  const compactBytes = Buffer.byteLength(JSON.stringify({ items: wire.document.state.items, itemEncoding: wire.document.state.itemEncoding }));
  const saving = ordinaryBytes - compactBytes;
  t.diagnostic(`variedItems=${rows.length}; ordinaryItemContainer=${ordinaryBytes}; compactItemContainer=${compactBytes}; ratio=${compactBytes / ordinaryBytes}; ordinaryState=${ordinary.bytes}; compactState=${wire.bytes}`);
  assert.ok(compactBytes <= ordinaryBytes * 0.4, `varied items ratio is ${compactBytes / ordinaryBytes}; compact=${compactBytes}, ordinary=${ordinaryBytes}`);
  assert.ok(ordinary.bytes - wire.bytes >= saving, 'the complete state retains at least the entire measured item saving');
  assert.deepEqual(expandItemSummaries(wire.document.state), ordinary.document.state, 'every varied JSON field survives exact decoding');
  assert.equal((await box.request(box.path + '/items/1')).status, 200);
});

test('[N26,A2] active-seat expiry rebuilds the cached state at the inclusive four-hour boundary and retains a three-hour-old seat', async t => {
  // Item progress has its own minute transitions; isolate this seat-only activity boundary.
  const box = await fixture(t, { items: 0, recentAge: 3 * 3_600_000 });
  assert.equal((await box.request(box.path + '/state')).document.state.agents.length, 1);
  box.advance(3_600_000);
  assert.equal((await box.request(box.path + '/state')).document.state.agents.length, 1);
  assert.equal(box.builds(), 1, 'the inclusive seat boundary still uses the clock-only cache hit');
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
  assert.ok([1, 2].includes(encoded.itemEncoding.version), 'the encoder selects a supported lossless wire format');
  const expanded = expandItemSummaries(JSON.parse(JSON.stringify(encoded)));
  assert.deepEqual(expanded, JSON.parse(before));
  assert.equal(JSON.stringify(state), before, 'packing does not mutate its source');
  expanded.items[0].blockedBy.push(99);
  expanded.items[0].counts.facts = 99;
  assert.deepEqual(expanded.items[1].blockedBy, []);
  assert.equal(expanded.items[1].counts.facts, 0, 'decoded rows do not share mutable defaults');
  assert.equal(expandItemSummaries(state), state, 'the default API and full snapshots need no decoding');
  assert.equal(compactItemSummaries({ items: [] }).items.length, 0);
  assert.throws(() => expandItemSummaries({ items: [], itemEncoding: { version: 99, defaults: {} } }), /invalid compact/u);
  assert.throws(() => expandItemSummaries({ items: [{ title: 'Missing id' }], itemEncoding: { version: 1, defaults: {} } }), /invalid compact/u);
  assert.throws(() => expandItemSummaries({ items: [], itemEncoding: { version: 1, defaults: { id: 1 } } }), /invalid compact/u);
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

/** Retain old wire compatibility while refusing malformed columns and preserving JSON ownership. */
test('[N26,A2] V1 compatibility and V2 columns preserve fresh nested values and refuse malformed metadata', () => {
  const old = { items: [{ id: 1, title: 'Old', counts: { facts: 3 } }, { id: 2, title: 'Older' }],
    itemEncoding: { version: 1, defaults: { specs: ['N26'], counts: { facts: 0 } } } };
  const restored = expandItemSummaries(old);
  restored.items[0].counts.facts = 99;
  restored.items[0].specs.push('A2');
  assert.equal(old.items[0].counts.facts, 3, 'old row-owned values are cloned too');
  assert.equal(restored.items[1].counts.facts, 0);
  assert.deepEqual(restored.items[1].specs, ['N26']);
  const columns = [
    ['id', 'r', [1, 2], []], ['title', 'r', ['First', 'Second'], []],
    ['counts', 'd', [0, 0], [{ facts: 2, verdicts: 1 }]],
    ['optional', 'd', [-1, 0], [null]],
    ['updatedAt', 't', [0, null], [1704067200000, []]],
    ['absentTime', 't', [null, 1], [1704067200000, [0]]],
    ['__proto__', 'd', [0, 0], [{ safe: true }]],
  ];
  const wire = { sequence: 8, items: columns, itemEncoding: { version: 2, count: 2 } };
  const before = JSON.stringify(wire), plain = expandItemSummaries(wire);
  assert.equal(Object.hasOwn(plain.items[0], 'optional'), false);
  assert.equal(plain.items[1].optional, null);
  assert.equal(Object.hasOwn(plain.items[0], 'absentTime'), false);
  assert.equal(plain.items[1].absentTime, '2024-01-01T00:00:00.001Z');
  assert.equal(plain.items[0].updatedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(plain.items[1].updatedAt, null);
  assert.equal(Object.getPrototypeOf(plain.items[0]), Object.prototype);
  assert.deepEqual(plain.items[0].__proto__, { safe: true }, 'special JSON keys remain own values');
  plain.items[0].counts.facts = 88;
  plain.items[0].__proto__.safe = false;
  assert.equal(plain.items[1].counts.facts, 2);
  assert.equal(plain.items[1].__proto__.safe, true);
  assert.equal(JSON.stringify(wire), before, 'decoding leaves every nested wire value untouched');
  const bad = [
    { ...wire, itemEncoding: { version: 2, count: Number.MAX_SAFE_INTEGER } },
    { ...wire, itemEncoding: { version: 2, count: 2, defaults: {} } },
    { ...wire, items: columns.concat([columns[0]]) },
    { ...wire, items: [columns[0], ['title', 'r', ['First'], []]] },
    { ...wire, items: [columns[0], ['title', 'd', [0, 1], ['Only']]] },
    { ...wire, items: [columns[0], columns[1], ['x', 'r', [null, null], [1, 0]]] },
    { ...wire, items: [columns[0], columns[1], ['x', 't', [0, 1], [8640000000000000, []]]] },
    { ...wire, items: [columns[0], columns[1], ['x', 'unknown', [0, 1], []]] },
    { ...wire, items: [columns[1], ['id', 'd', [-1, 0], [2]]] },
  ];
  for (const broken of bad) assert.throws(() => expandItemSummaries(broken), /invalid compact/u);
});
