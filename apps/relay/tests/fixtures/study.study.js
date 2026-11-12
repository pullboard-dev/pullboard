import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
} from '../../../lib/index.js';
/** A measured private relay study, with explicit coverage limits rather than inferred parity [H5,H17]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { MOVE_OPERATIONS } from '../../../../packages/moves/index.js';
import { relaySnapshot } from '../../../../packages/pages/index.js';
import { relayClientFixture } from '../../../cli/tests/fixtures/relay/client.js';
import {
  differences,
  readRelay,
} from '../../../../packages/pages/tests/fixtures/study.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

test('relay study measures seeded native and API2 reader parity [H5,H17]', { timeout: 180_000 }, async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const item = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Study seeded item',
    criterion: 'Full detail survives relay paging.', brief: 'A seeded detail field.', specIds: [] });
  store.editItem(board, item, { agentId: 'coordinator', brief: 'Changed seeded detail.', reason: 'study seed' });
  store.appendFact(board, item, { agentId: 'coordinator', kind: 'measurement', text: 'Measured seed observation.' });
  const decision = store.shout(board, { from: 'coordinator', to: 'all', text: 'Seeded decision?', lanes: [box.lane], decision: true });
  store.shout(board, { from: 'coordinator', to: 'all', text: 'Seeded answer.', lanes: [box.lane], answers: decision });
  const uploadStart = box.transit.length;
  const started = performance.now();
  const published = await box.cli('status');
  assert.equal(published.code, 0, 'the real linked CLI publishes the seeded board');
  const publishMs = performance.now() - started;
  const read = await readRelay(box);
  const observedAt = Date.parse(read.document.presentation.state.observedAt);
  assert.ok(Number.isSafeInteger(observedAt), 'compare the sealed observation at its actual clock');
  const expected = relaySnapshot(box.root, { observedAt }, RELAY_PRESENTATION_PORTS);
  const full = differences(expected.presentation, read.document.presentation);
  const tables = differences(expected.tables, read.document.tables);
  const writes = box.transit.slice(uploadStart).filter(row => ['PUT', 'POST'].includes(row.method));
  const covered = ['addItem', 'editItem', 'appendFact', 'shout'];
  t.diagnostic(JSON.stringify({ phase: 'initial-api2-parity', engine: ENGINE_VERSION,
    node: process.versions.node, platform: process.platform, arch: process.arch,
    events: expected.tables.event.length, publishMs, uploadRequests: writes.length,
    uploadBytes: writes.reduce((sum, row) => sum + row.request.byteLength, 0),
    readMs: read.readMs, readRequests: read.requests, readBytes: read.receivedBytes,
    projectionDifferences: full, tableDifferences: tables, coveredMoves: covered,
    uncoveredMoves: MOVE_OPERATIONS.filter(operation => !covered.includes(operation)),
    limitation: 'Private loopback relay, initial seed only; not every move, throughput ceiling or failure study yet.' }));
  assert.equal(tables.length, 0, 'the measured relay restores every native table field');
  assert.equal(full.length, 0, 'the measured relay restores every full presentation field');
});

test('relay study measures 1k 10k and 50k native-event sync and private request saturation [H5,H17]', { timeout: 300_000 }, async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  for (const target of [1000, 10_000, 50_000]) {
    let events = board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
    const seedStart = performance.now();
    store.atomic(board, () => {
      while (events < target) {
        const text = 'Study event ' + events + ' ' + createHash('sha256').update(String(events)).digest('hex');
        store.shout(board, { from: 'coordinator', to: 'all', text, lanes: [box.lane] });
        events++;
      }
    });
    const seedMs = performance.now() - seedStart;
    assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, target);
    const uploadStart = box.transit.length;
    const publishStart = performance.now();
    const result = await box.cli('status');
    assert.equal(result.code, 0, 'the actual CLI syncs the measured event scale');
    const publishMs = performance.now() - publishStart;
    const read = await readRelay(box);
    const observedAt = Date.parse(read.document.presentation.state.observedAt);
    assert.ok(Number.isSafeInteger(observedAt), 'compare the sealed observation at its actual clock');
    const expected = relaySnapshot(box.root, { observedAt }, RELAY_PRESENTATION_PORTS);
    const projection = differences(expected.presentation, read.document.presentation);
    const tables = differences(expected.tables, read.document.tables);
    const writes = box.transit.slice(uploadStart).filter(row => ['PUT', 'POST'].includes(row.method));
    t.diagnostic(JSON.stringify({ phase: 'event-scale', events: target, seedMs, publishMs,
      nativeJsonBytes: Buffer.byteLength(JSON.stringify(expected)),
      uploadRequests: writes.length, uploadBytes: writes.reduce((sum, row) => sum + row.request.byteLength, 0),
      readMs: read.readMs, readRequests: read.requests, readBytes: read.receivedBytes,
      projectionDifferences: projection, tableDifferences: tables,
      workload: 'One private loopback API2 relay; unique SHA256-tagged shouts, batched native writes; not 50k independently synced moves.' }));
    assert.equal(projection.length, 0);
    assert.equal(tables.length, 0);
  }
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const headers = { authorization: 'Bearer ' + state.token, 'x-pullboard-engine': String(ENGINE_VERSION) };
  for (const concurrency of [1, 4, 16, 64, 256, 1024]) {
    const times = [], statuses = {};
    const started = performance.now();
    /** Use real authenticated root reads, including each response body and the server's pinned-reader allocation. */
    async function read() {
      const begin = performance.now();
      const response = await fetch(box.origin + '/api/v2/boards/' + state.board + '/state', { headers });
      await response.arrayBuffer();
      times.push(performance.now() - begin);
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
    }
    for (let wave = 0; wave < 3; wave++) await Promise.all(Array.from({ length: concurrency }, read));
    const wallMs = performance.now() - started;
    times.sort((a, b) => a - b);
    const p95Ms = times[Math.ceil(times.length * 0.95) - 1];
    t.diagnostic(JSON.stringify({ phase: 'private-root-request-rate', concurrency, requests: times.length,
      wallMs, requestsPerSecond: times.length * 1000 / wallMs, p95Ms, statuses,
      scope: 'Same-process private loopback authenticated API2 root reads, three waves, no TLS; not external production capacity.' }));
    if (p95Ms > 500 || Object.keys(statuses).some(status => status !== '200')) break;
  }
});

