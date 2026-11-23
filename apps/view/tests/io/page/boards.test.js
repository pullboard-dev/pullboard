// pullboard: browser
/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/activity.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/io/shouts.css apps/view/src/io/notch.css */
/** @pullboard-test-gui */
/** The production sidebar groups the local view's boards and each relay board under its machine name in real Chrome [C7,N26,#9455]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { startChrome } from '../../../../cli/tests/fixtures/chrome.js';
import { findChromeExecutable } from '../../../../cli/tests/fixtures/chrome.js';
import { stableChrome } from '../../../../cli/tests/fixtures/cockpit/stable.js';
import { cockpitPage } from '../../../index.js';
import { dashboardRuntime } from '../../../index.js';
import { activityRuntime } from '../../../src/io/activity/runtime.js';
import { pipelineRuntime } from '../../../src/io/pipeline/runtime.js';
import { composeViewStyles } from '../../../index.js';

/** The real page over a view that lists no board of its own: the test seeds the boards the sidebar draws. */
async function startFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (type, body, status = 200) => response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    if (url.pathname === '/') return send('text/html; charset=utf-8', cockpitPage('', { readOnly: true, requests: true, apiHeaders: {}, stylesheet: '/view.css', commandPhrases: () => ['add'] }));
    if (url.pathname === '/view.css') return send('text/css', composeViewStyles());
    if (url.pathname === '/api/v1/boards') return send('application/json', JSON.stringify({ version: 1, boards: [], warnings: [] }));
    return send('application/json', JSON.stringify({ error: 'not in this fixture' }), 404);
  });
  const origin = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** One listed board as the page holds it: a local row carries its machine, a relay row the machine that shared it. */
const row = (id, name, source, machine) => ({ ok: true, id: id.repeat(32), root: source === 'relay' ? id.repeat(32) : `/work/${name}`, name, source, machine, decisions: 0, pending: 0, drafts: 0, holds: 0, open: 1 });

test('view.x-page-boards.sidebar-groups-by-machine: clause 2: with a local view and a relay source, the sidebar shows both machine headings with their boards [C7,N26,#9455]', { timeout: 120_000 }, async (t) => {
  if (!findChromeExecutable()) return t.skip('Install Chrome or set PULLBOARD_CHROME for the sidebar grouping check.');
  const fixture = await startFixture();
  const chrome = await stableChrome(await startChrome());
  try {
    await chrome.navigate(`${fixture.origin}/`);
    await chrome.waitFor("typeof renderSide === 'function' && document.getElementById('proj-list') !== null");
    const draw = (rows) => chrome.stable(`(() => { data = store.set({ root: null, project: null, group: null, projects: ${JSON.stringify(rows)}, groups: [] }); renderSide();
      return [...document.querySelectorAll('#proj-list .side-machine')].map((group) => ({ machine: group.dataset.machine, heading: group.querySelector('h3').textContent, boards: [...group.querySelectorAll('.pname')].map((name) => name.textContent) })); })()`);
    const mixed = await draw([row('a', 'Atlas', 'local', 'desk-mac'), row('b', 'Harbor', 'local', 'desk-mac'), row('c', 'Remote board', 'relay', 'Tower')]);
    assert.deepEqual(mixed, [
      { machine: 'desk-mac', heading: 'this computer', boards: ['Atlas', 'Harbor'] },
      { machine: 'Tower', heading: 'Tower', boards: ['Remote board'] },
    ], 'this computer holds the local boards and the relay machine holds its own');
    const local = await draw([row('a', 'Atlas', 'local', 'desk-mac')]);
    assert.deepEqual(local, [], 'with no relay board the sidebar draws no machine heading');
  } finally {
    await chrome.close();
    await fixture.close();
  }
});

const MOST_PER_PAGE = 5000;
const LOG_EVENTS = 12_345;
const LOG_END = Date.parse('2026-11-20T01:00:00Z');

/** A stub board of LOG_EVENTS events, one a second, whose api records every events read and answers it like the real route. */
function eventLog() {
  const reads = [];
  const api = async path => {
    reads.push(path);
    const query = new URLSearchParams(path.split('?')[1]), after = Number(query.get('after')), limit = Number(query.get('limit'));
    const events = [];
    for (let id = after + 1; id <= LOG_EVENTS && events.length < limit; id++) events.push({ event_id: id, event_at: new Date(LOG_END - (LOG_EVENTS - id) * 1000).toISOString() });
    return { events };
  };
  return { api, reads };
}

/** Every events read asked for at most one page, and the pages together reach the last event. */
function assertPaged(reads, who) {
  const limits = reads.map(path => Number(new URLSearchParams(path.split('?')[1]).get('limit')));
  assert.ok(limits.length > 0 && limits.every(limit => limit >= 1 && limit <= MOST_PER_PAGE), `${who} asks for at most ${MOST_PER_PAGE} events per page: ${reads.join(' ')}`);
  const afters = reads.map(path => Number(new URLSearchParams(path.split('?')[1]).get('after')));
  assert.ok(Math.max(...afters) >= LOG_EVENTS - MOST_PER_PAGE, `${who} pages on until the last events of the log: ${afters.join(',')}`);
}

test('view.page.event-pages-capped: clause 1: the dashboard history, the pipeline page and the activity runtime each ask for at most 5,000 events per page and read to the end of the log [N26]', async t => {
  const previous = globalThis.document;
  const region = { innerHTML: '', dataset: {}, isConnected: true, clientWidth: 800, addEventListener() {}, contains: () => true, querySelector: () => null, querySelectorAll: () => [] };
  globalThis.document = { getElementById: () => region, addEventListener() {}, visibilityState: 'visible' };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const settle = async done => { for (let turn = 0; turn < 200_000 && !done(); turn++) await Promise.resolve(); };
  const project = { root: '/board', sequence: LOG_EVENTS, observedAt: new Date(LOG_END).toISOString() };

  const dashboard = eventLog();
  let dashboardEvents = [];
  const dashboardView = dashboardRuntime({ model: (_project, events) => { dashboardEvents = events; return {}; }, html: () => '', summary: () => null, current: () => project.root, redraw: () => {}, boardPath: () => '/b', api: dashboard.api });
  dashboardView.draw(project, '');
  await settle(() => dashboard.reads.length >= 3);
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
  dashboardView.draw(project, '');
  assert.equal(dashboardEvents.length, LOG_EVENTS, 'the dashboard holds the whole log');
  assertPaged(dashboard.reads, 'the dashboard history');

  const pipeline = eventLog();
  let pipelineEvents = [];
  const pipelineView = pipelineRuntime({ model: (_project, events) => { pipelineEvents = events; return {}; }, html: () => '<b>drawn</b>', boardPath: () => '/b', api: pipeline.api, current: () => project.root, redraw: () => pipelineView.draw(project),
    windowMinutes: () => 180, itemsHref: () => '#', itemHref: () => '#', openItems() {}, machineHere: false });
  pipelineView.draw(project);
  await settle(() => region.innerHTML === '<b>drawn</b>');
  assert.equal(pipelineEvents.length, LOG_EVENTS, 'the pipeline holds the whole window, which is the whole log');
  assertPaged(pipeline.reads, 'the pipeline page');

  const activity = eventLog();
  let activityEvents = [], finished;
  const done = new Promise(resolve => { finished = resolve; });
  const activityView = activityRuntime({ flow: (_project, events) => { activityEvents = events; return { hours: [], people: [], counts: {}, events: [], journeyById: new Map() }; }, html: () => '', tip: () => '', step: ui => ui, start: () => ({ open: null, item: null }),
    api: activity.api, boardPath: () => '/b', current: () => project.root, view: () => ({ activityWin: 24 }), project: () => project, active: () => true, working: () => [], controls: () => '', onFilter: () => {}, after: () => finished(), remember: () => null });
  activityView.draw(project);
  await done;
  activityView.draw(project);
  assert.equal(activityEvents.length, LOG_EVENTS, 'the activity page holds the whole window');
  assertPaged(activity.reads, 'the activity page');
});
