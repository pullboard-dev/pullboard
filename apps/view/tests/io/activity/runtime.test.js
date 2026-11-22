/** @pullboard-test-input apps/view/src/io/activity/runtime.js apps/view/src/io/dashboard/runtime.js apps/view/src/io/pipeline/runtime.js apps/view/src/io/page/boards.js apps/view/src/io/serve.js apps/view/src/logic/cockpit/live.js */
/** @pullboard-world-pin reads the view's shipped source files to prove every events read names a limit; no browser is needed for the path text. */
/** The Activity page reads its window of events in bounded pages, never as one unbounded read of the log [N26,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BroadcastChannel } from 'node:worker_threads';
import { test } from 'node:test';
import { serveApi } from '../../../../../packages/api/index.js';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { openCellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { openBoardForRead } from '../../../../../packages/store/index.js';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';
import { viewApiPorts } from '../../../src/io/ports.js';
import { activityRuntime } from '../../../src/io/activity/runtime.js';

const ITEMS = 10_000;
const EVENTS = 120_000;
const SHOUTS = 5_000;
const DETAIL_CHARS = 700;
const HEAP_LIMIT = 1024 ** 3;
const SECRET = 'fixture-secret';

/** Put a fake page in place for the runtime: the node it draws into and the document it listens on. */
function fakePage(t) {
  const previous = globalThis.document;
  const node = { dataset: {}, isConnected: true, clientWidth: 800, innerHTML: '', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  globalThis.document = { getElementById: id => (id === 'activity' ? node : null), addEventListener() {}, visibilityState: 'visible' };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
}

/** The runtime's other dependencies, as stand-ins that draw nothing; `flow` receives every event the page holds. */
function standIns({ flow, root, snapshot, finished }) {
  return {
    flow, html: () => '', tip: () => '', step: ui => ui, start: () => ({ open: null, item: null }),
    boardPath: () => '/api/boards/paged', current: () => root, view: () => ({ activityWin: 24 }), project: () => snapshot, active: () => true,
    working: () => [], controls: () => '', onFilter: () => {}, after: finished, remember: () => null,
  };
}

const emptyModel = { hours: [], people: [], counts: {}, events: [], journeyById: new Map() };

test('view.activity.events-paged: clause 1: the Activity page reads events in pages with a limit until a page comes back short [N26,C7]', async t => {
  fakePage(t);
  const NOW = Date.parse('2026-11-22T12:00:00Z');
  const all = Array.from({ length: 5 }, (_, index) => ({ event_id: index + 1, event_at: new Date(NOW - 60_000 + index).toISOString() }));
  const snapshot = { root: '/private-fixture', sequence: 5, observedAt: new Date(NOW).toISOString() };
  const reads = [];
  let held = [], finished;
  const done = new Promise(resolve => { finished = resolve; });
  const runtime = activityRuntime({
    ...standIns({ flow: (_project, events) => { held = events; return emptyModel; }, root: snapshot.root, snapshot, finished: () => finished() }),
    eventBatch: 2,
    api: async path => {
      reads.push(path);
      const query = new URLSearchParams(path.split('?')[1]);
      const limit = Number(query.get('limit'));
      assert.ok(limit > 0, `every events read names its limit: ${path}`);
      return { events: all.filter(event => event.event_id > Number(query.get('after'))).slice(0, limit) };
    },
  });
  runtime.draw(snapshot);
  await done;
  const pages = reads.filter(path => !path.endsWith('&limit=1')).map(path => path.replace(/^.*\/events\?/u, ''));
  assert.deepEqual(pages, ['after=0&limit=2', 'after=2&limit=2', 'after=4&limit=2']);
  assert.deepEqual(held.map(event => event.event_id), [1, 2, 3, 4, 5], 'the paged read holds every event of the window');
});

/** Fill the board with the live board's scale: items, events of a real detail size and shouts, all inside the Activity window. */
function fillBoard(board, now) {
  const first = Math.floor(now / 1000) - EVENTS / 2 - 600;
  board.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ITEMS})
    INSERT INTO item (item_lane, item_title, item_created_by, item_created_at, item_updated_at)
    SELECT 'app', 'Item ' || i, 'coordinator', strftime('%Y-%m-%dT%H:%M:%fZ', ${first} + i, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', ${first} + i, 'unixepoch') FROM n`);
  board.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${EVENTS})
    INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail)
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ${first} + i * 0.5, 'unixepoch'), 'coordinator', CASE WHEN i % 10 = 0 THEN 'merged' ELSE 'shout' END, 1 + i % ${ITEMS},
      '{"note":"' || substr(replace(hex(zeroblob(${DETAIL_CHARS})), '0', 'x'), 1, ${DETAIL_CHARS}) || '"}' FROM n`);
  board.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${SHOUTS})
    INSERT INTO shout (shout_from, shout_to, shout_text, shout_at)
    SELECT 'coordinator', 'person', 'Shout ' || i, strftime('%Y-%m-%dT%H:%M:%fZ', ${first} + i, 'unixepoch') FROM n`);
  return board.db.prepare('SELECT MAX(event_id) AS last FROM event').get().last;
}

const CELL = new URL('../../../../../packages/store/tests/fixtures/cell.js', import.meta.url).href;
const STORE = new URL('../../../../../packages/store/index.js', import.meta.url).href;
const API = new URL('../../../../../packages/api/index.js', import.meta.url).href;

/**
 * A handler ports module, as a data: URL: the API's real pool handlers over the fixture board, with the events handler
 * reporting this worker's own V8 heap (used_heap_size, read inside the worker while the rows are still held) on `channel`
 * after every read. The read itself is the production one.
 */
function handlerPorts(channel) {
  const source = `import { BroadcastChannel } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import { openCellBoard } from ${JSON.stringify(CELL)};
import { openBoardForRead } from ${JSON.stringify(STORE)};
import { poolHandlers } from ${JSON.stringify(API)};
export function boardHandlerPorts({ isMain }) {
  const real = poolHandlers({ boardOpeners: { openBoard: openCellBoard, openBoardForRead } }, { isMain });
  const report = new BroadcastChannel(${JSON.stringify(channel)});
  return { handlers: { ...real, async events(args) {
    const rows = await real.events(args);
    report.postMessage({ heap: getHeapStatistics().used_heap_size, rows: rows.length, limit: args.limit ?? null });
    return rows;
  } } };
}
`;
  return 'data:text/javascript,' + encodeURIComponent(source);
}

/** Serve the real API over the filled board, its event reads running in the pool worker above, and return a reader of its JSON answers. */
async function servedBoard(t, project, channel) {
  const api = await serveApi({ projects: () => [{ root: project.repo, name: 'Heap fixture' }], secret: SECRET, runCommand: async () => 0, isMain: false,
    refusalDocument: error => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }),
    boardOpeners: { openBoard: openCellBoard, openBoardForRead }, viewPorts: viewApiPorts, handlerPorts: handlerPorts(channel) });
  t.after(() => api.close());
  const call = async path => {
    const response = await fetch(`http://127.0.0.1:${api.port}${path}`, { headers: { 'x-pullboard-key': SECRET }, signal: AbortSignal.timeout(60_000) });
    return { status: response.status, document: await response.json() };
  };
  const listed = await call('/api/v1/boards');
  return { call, path: '/api/v1/boards/' + listed.document.boards[0].id };
}

test('view.activity.large-board-heap: clause 1: on a board of 10,000 items and 120,000 events the API pool worker serving the Activity page event reads peaks under 1 GB of heap over 20 or more bounded page reads [N26,C7]', { timeout: 300_000 }, async t => {
  const project = cellProject(t, { real: true, gate: 'true' });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  const now = Date.now();
  const sequence = fillBoard(board, now);
  const channel = `heap-${process.pid}-${now}`;
  // The worker's own readings arrive on a channel; each is one event read served by the pool worker.
  const workerReads = [];
  const listener = new BroadcastChannel(channel);
  listener.onmessage = message => workerReads.push(message.data);
  t.after(() => listener.close());
  const box = { root: project.repo, ...(await servedBoard(t, project, channel)) };
  fakePage(t);
  const snapshot = { root: box.root, sequence, observedAt: new Date(now).toISOString() };
  let widest = 0, held = [], finished;
  const done = new Promise(resolve => { finished = resolve; });
  const reads = [];
  const runtime = activityRuntime({
    ...standIns({ flow: (_project, events) => { held = events; return emptyModel; }, root: box.root, snapshot, finished: () => finished() }),
    boardPath: () => box.path,
    api: async path => {
      reads.push(path);
      const { status, document } = await box.call(path);
      assert.equal(status, 200, path);
      widest = Math.max(widest, document.events.length);
      return document;
    },
  });
  runtime.draw(snapshot);
  await done;
  runtime.draw(snapshot);

  const pageReads = workerReads.filter(read => read.rows > 1);
  const peak = Math.max(...workerReads.map(read => read.heap));
  assert.ok(pageReads.length >= 20, `the worker served at least 20 Activity page reads: ${pageReads.length}`);
  assert.ok(workerReads.every(read => read.limit !== null && read.limit <= 5000), 'the worker served no unbounded event read');
  const eventReads = reads.filter(path => /\/events\?/u.test(path));
  assert.ok(eventReads.every(path => /[?&]limit=\d+/u.test(path)), 'every events read names its limit');
  assert.ok(widest <= 5000, `no read returned more than one page: ${widest}`);
  assert.equal(held.length, sequence, 'the page holds every event of the window, as one unbounded read gave it');
  console.log(`ACTIVITY_WORKER_PEAK_HEAP_MB=${(peak / 1024 ** 2).toFixed(1)} items=${ITEMS} events=${sequence} worker_reads=${workerReads.length} page_reads=${pageReads.length} widest_page=${widest}`);
  assert.ok(peak < HEAP_LIMIT, `worker peak heap ${peak} bytes stays under 1 GB`);
});

const VIEW_EVENT_READERS = ['io/activity/runtime.js', 'io/dashboard/runtime.js', 'io/pipeline/runtime.js', 'io/page/boards.js', 'io/serve.js', 'logic/cockpit/live.js'];

test('view.activity.no-unbounded-event-read: clause 1: no read in the view event path asks the board for events without a limit [N26,C7]', () => {
  for (const file of VIEW_EVENT_READERS) {
    const source = readFileSync(new URL('../../../src/' + file, import.meta.url), 'utf8');
    const reads = source.match(/\/events\?after=[^;\n]*/gu) ?? [];
    assert.ok(reads.length > 0, `${file} reads events by cursor`);
    assert.ok(reads.every(read => /limit=/u.test(read)), `${file} names a limit on every events read: ${reads.join(' | ')}`);
    assert.doesNotMatch(source, /\/events['`"]\)/u, `${file} makes no events read with no cursor and no limit`);
  }
});
