/** The Activity page reads its window of events in bounded pages, never as one unbounded read of the log [N26,C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeBoard } from '../../../../../packages/store/index.js';
import { apiHttpBox } from '../../../../cli/tests/fixtures/api.js';
import { openKitBoard } from '../../../../cli/tests/fixtures/board.js';
import { activityRuntime } from '../../../src/io/activity/runtime.js';

const ITEMS = 10_000;
const EVENTS = 120_000;
const SHOUTS = 5_000;
const DETAIL_CHARS = 700;
const HEAP_LIMIT = 1024 ** 3;

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
function fillBoard(root, now) {
  const board = openKitBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  const first = Math.floor(now / 1000) - EVENTS / 2 - 600;
  try {
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
  } finally { closeBoard(board); }
}

test('view.activity.large-board-heap: clause 1: on a board of 10,000 items and 120,000 events the Activity page reads in bounded pages and peak heap stays under 1 GB [N26,C7]', { timeout: 300_000 }, async t => {
  const box = await apiHttpBox(t);
  const now = Date.now();
  const sequence = fillBoard(box.root, now);
  fakePage(t);
  const snapshot = { root: box.root, sequence, observedAt: new Date(now).toISOString() };
  let peak = 0, widest = 0, held = [], finished;
  const sample = () => { peak = Math.max(peak, process.memoryUsage().heapUsed); };
  const done = new Promise(resolve => { finished = resolve; });
  const reads = [];
  const runtime = activityRuntime({
    ...standIns({ flow: (_project, events) => { held = events; return emptyModel; }, root: box.root, snapshot, finished: () => finished() }),
    boardPath: () => box.path,
    api: async path => {
      sample();
      reads.push(path);
      const { status, document } = await box.call(path);
      assert.equal(status, 200, path);
      widest = Math.max(widest, document.events.length);
      sample();
      return document;
    },
  });
  runtime.draw(snapshot);
  await done;
  runtime.draw(snapshot);
  sample();

  const eventReads = reads.filter(path => /\/events\?/u.test(path));
  assert.ok(eventReads.every(path => /[?&]limit=\d+/u.test(path)), 'every events read names its limit');
  assert.ok(widest <= 5000, `no read returned more than one page: ${widest}`);
  assert.equal(held.length, sequence, 'the page holds every event of the window, as one unbounded read gave it');
  console.log(`ACTIVITY_PEAK_HEAP_MB=${(peak / 1024 ** 2).toFixed(1)} items=${ITEMS} events=${sequence} reads=${eventReads.length} widest_page=${widest}`);
  assert.ok(peak < HEAP_LIMIT, `peak heap ${peak} bytes stays under 1 GB`);
});
