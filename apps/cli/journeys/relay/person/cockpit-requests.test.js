// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Real relay browser journeys and their owned setup [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
} from 'node:fs';
import {
  createServer,
  request,
} from 'node:http';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { performance } from 'node:perf_hooks';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../../index.js';
import {
  scratch,
  machine,
  project,
  fetchLive,
  startView,
  target,
  chromeExecutable,
  openSnapshotChrome,
  stopOwnedChrome,
} from '../../../tests/fixtures/cockpit/harness.js';

test('relay person requests stay explicit, read-only and visible [H12,H5]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the person-request transport proof.');

  const box = machine();
  const requestRows = Array.from({ length: 12 }, (_, index) => `- P${index + 1} [draft, must] Keep the reading position measurable. | gate: test`).join('\n');
  const requestSpec = `# Person request fixture\n\n## G · Goals\n- G1 [approved, must] Existing item remains readable. | gate: test\n${requestRows}\n- G2 [draft, must] The person can approve this row. | gate: test\n`;
  const app = project(box, 'person requests', requestSpec);
  box.run(app.repo, 'add', 'web', 'Existing private item', '--specs', 'G1', '--criterion', 'remains readable');
  box.run(app.repo, 'shout', 'person', 'Should this item ship?', '--decision');
  const live = await startView(box);
  const intents = [];
  const records = [];
  const requestTimeline = [];
  let chrome;
  let diagnosticEmitted = false;
  /** Build the opted-in page or a refusal control with the same read-only transport. */
  const page = (options = {}) => cockpitPage('', {
    readOnly: true, requests: true, transportModule: '/transport.js', stylesheet: '/view.css', ...options,
  });
  const transportModule = `/** Provide the permitted stand-in transport while leaving real board reads untouched. */
  export async function createTransport({ onUpdate }) {
    window.__transportCalls = [];
    window.__setPersonRequest = async (id, status, error) => {
      await fetch('/request-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status, error }) });
      await onUpdate();
    };
    window.__holdNextIntent = false;
    window.__releaseHeldIntent = null;
    window.__pendingEarlierTransportCalls = 0;
    window.__lateEarlierTransportError = null;
    window.__releaseEarlierTransportCall = null;
    const transport = { async request(path, body) {
      window.__transportCalls.push({ path, body: body ?? null });
      if (body) {
        if (window.__holdNextIntent) {
          window.__holdNextIntent = false;
          await new Promise(resolve => { window.__releaseHeldIntent = resolve; });
        }
        const response = await fetch('/intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const document = await response.json();
        if (!response.ok) throw new Error(document.error?.message || String(response.status));
        return document;
      }
      const response = await fetch('/fixture' + path);
      const document = await response.json();
      if (!response.ok) throw new Error(document.error?.message || String(response.status));
      if (new URL(path, location.origin).pathname.endsWith('/state')) document.state.personRequests = await (await fetch('/request-state')).json();
      return document;
    } };
    /** Hold a genuine earlier read so the test can release it after taking a stale count. */
    window.__queueEarlierTransportCall = (path) => {
      window.__pendingEarlierTransportCalls += 1;
      window.__releaseEarlierTransportCall = () => {
        window.__releaseEarlierTransportCall = null;
        void transport.request(path).catch(error => { window.__lateEarlierTransportError = error.message; })
          .finally(() => { window.__pendingEarlierTransportCalls -= 1; });
      };
    };
    return transport;
  }`;
  /** Serve controlled request receipts and proxy reads to the actual private Git/SQLite board. */
  async function fixtureRequest(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const receivedAt = Date.now();
    if (url.pathname === '/request-state' && request.method === 'GET') {
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(records));
    }
    if (url.pathname === '/request-status' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const row = records.find(entry => entry.id === update.id);
      row.status = update.status;
      if (update.error) row.error = update.error;
      return response.writeHead(200).end();
    }
    if (url.pathname === '/intent' && request.method === 'POST') {
      requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-received', at: receivedAt });
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const move = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const allowed = ['add', 'shout', 'answer', 'hold', 'spec-approve', 'spec-decline'].includes(move.verb)
        && Object.keys(move).every(key => ['verb', 'item', 'args'].includes(key));
      if (!allowed) return response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Only literal person requests are allowed.' } }));
      intents.push(structuredClone(move));
      const row = { id: 'request-' + intents.length, sequence: intents.length, at: '2026-10-08T00:00:00.000Z', by: 'person', move, status: 'waiting' };
      records.push(row);
      requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-accepted', at: Date.now(), id: row.id, verb: move.verb });
      response.once('finish', () => requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-response-finished', at: Date.now(), id: row.id, status: response.statusCode }));
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: 1, event: { event_id: row.sequence, kind: 'request' }, result: { request: row } }));
    }
    if (url.pathname.startsWith('/fixture/')) {
      if (request.method !== 'GET') return response.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'The read-only fixture accepts GET only.' } }));
      const isState = url.pathname.endsWith('/state');
      if (isState) requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-start', at: receivedAt });
      const upstream = await fetchLive(live.base + url.pathname.slice('/fixture'.length) + url.search, { headers: { 'x-pullboard-key': live.key } });
      const text = await upstream.text();
      if (isState) requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-response', at: Date.now(), status: upstream.status });
      if (isState) response.once('finish', () => requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-finished', at: Date.now(), status: response.statusCode }));
      return response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(text);
    }
    response.writeHead(404).end();
  }
  /** Serve each capability control and the same-origin stand-in request protocol. */
  const pageServer = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/without-capability' || url.pathname === '/snapshot') {
      const body = url.pathname === '/'
        ? page({})
        : url.pathname === '/snapshot'
          ? cockpitPage('', { snapshot: true, requests: true, stylesheet: '/view.css' })
          : cockpitPage('', { readOnly: true, transportModule: '/transport.js', stylesheet: '/view.css' });
      return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    }
    if (url.pathname.startsWith('/api/v1/') && url.pathname.endsWith('.json')) {
      const target = url.pathname.slice(0, -'.json'.length) + url.search;
      const upstream = await fetchLive(live.base + target, { headers: { 'x-pullboard-key': live.key } });
      return response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
    }
    if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(transportModule);
    if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(new URL('../../../../view/src/io/main.css', import.meta.url)));
    return fixtureRequest(request, response);
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-person-request-chrome-'));
  scratch.push(profile);
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${pageServer.address().port}/`, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project && typeof window.__setPersonRequest === 'function'");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.click("document.querySelector('[data-tab=\"items\"]')");
    await chrome.waitFor("view.tab === 'items' && !document.querySelector('[data-pane=\"items\"]').hidden && document.querySelector('#new-item')");
    assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'the request view fits a phone viewport');
    assert.equal(await chrome.stable("document.body.classList.contains('requests') && getComputedStyle(document.querySelector('#new-item')).display !== 'none' && document.querySelector('#new-item').getBoundingClientRect().height >= 44"), true, 'the explicit capability exposes usable person controls');
    await chrome.click("document.querySelector('[data-tab=\"shouts\"]')"); await chrome.stable("document.querySelector('#shout-to').value = 'coordinator'"); await chrome.stable("document.querySelector('#shout-text').value = 'Please review this item.'"); await chrome.stable("document.querySelector('#shout-form').requestSubmit()");
    await chrome.waitFor("data?.project?.personRequests?.length === 1");
    assert.deepEqual(intents.at(-1), { verb: 'shout', args: { to: 'coordinator', text: 'Please review this item.' } });
    await chrome.click("document.querySelector('[data-tab=\"spec\"]')");
    await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.stable("document.querySelector('#spec-list [data-row=\"spec:G2\"]').scrollIntoView({ block: 'center' })");
    await chrome.waitFor('window.scrollY > 0');
    await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.waitFor("view.row.spec === 'G2'");
    const reading = JSON.parse(await chrome.stable(`JSON.stringify({ root: view.root, boardRoot: data.project.root, row: view.row.spec, scroll: window.scrollY,
      requestPanel: (() => { const node = document.querySelector('#person-requests'), rect = node.getBoundingClientRect(); return { hidden: node.hidden, top: rect.top, height: rect.height, documentTop: rect.top + scrollY, count: node.querySelectorAll('[data-person-request]').length }; })(),
      rowBox: (() => { const node = document.querySelector('#spec-list [data-row="spec:G2"]'), rect = node.getBoundingClientRect(); return { connected: node.isConnected, top: rect.top, height: rect.height, documentTop: rect.top + scrollY }; })(), pageHeight: document.documentElement.scrollHeight })`));
    assert.equal(reading.root, reading.boardRoot, 'the selected spec row belongs to the displayed board');
    assert.equal(reading.row, 'G2', 'G2 is the selected reading row before approval');
    await chrome.waitFor("document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    assert.equal(await chrome.stable(`(() => {
      const usable = document.querySelector('#spec-detail button[data-row-decision="approve"]').getBoundingClientRect().height >= 44;
      const trace = window.__personRequestReadingTrace = { armedAt: performance.now(), events: [], mutationBatches: 0, scrollEvents: 0 };
      const box = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { connected: node.isConnected, hidden: Boolean(node.closest('[hidden]')), top: rect.top, bottom: rect.bottom,
          height: rect.height, documentTop: rect.top + scrollY, text: node.textContent.trim().slice(0, 100) };
      };
      const capture = (type, detail = {}) => {
        trace.events.push({ type, at: performance.now(), scrollY, pageHeight: document.documentElement.scrollHeight,
          panel: box('#person-requests'), row: box('#spec-list [data-row="spec:G2"]'),
          requestCount: document.querySelectorAll('#person-requests [data-person-request]').length,
          active: document.activeElement?.id || null, selectedRow: view.row.spec, tab: view.tab, ...detail });
        if (trace.events.length > 80) trace.events.splice(0, trace.events.length - 80);
      };
      trace.capture = capture;
      trace.serialize = () => ({ armedAt: trace.armedAt, mutationBatches: trace.mutationBatches, scrollEvents: trace.scrollEvents, events: trace.events });
      trace.observer = new MutationObserver(changes => {
        const relevant = changes.some(change => {
          const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
          return target?.closest?.('#person-requests, #spec-list') || [...change.addedNodes, ...change.removedNodes].some(node =>
            node.nodeType === 1 && (node.matches?.('#person-requests, #spec-list') || node.querySelector?.('#person-requests, #spec-list')));
        });
        if (!relevant) return;
        trace.mutationBatches += 1;
        capture('dom-mutation', { records: changes.length });
      });
      trace.observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true,
        attributeFilter: ['hidden', 'class', 'style'] });
      trace.resize = new ResizeObserver(entries => capture('resize', { resized: entries.map(entry => entry.target.id || entry.target.dataset.row || entry.target.className).slice(0, 8) }));
      for (const node of [document.querySelector('#person-requests'), document.querySelector('#spec-list [data-row="spec:G2"]')]) if (node) trace.resize.observe(node);
      trace.onScroll = () => { trace.scrollEvents += 1; capture('scroll'); };
      window.addEventListener('scroll', trace.onScroll, { passive: true });
      trace.dispose = () => { trace.observer.disconnect(); trace.resize.disconnect(); window.removeEventListener('scroll', trace.onScroll); };
      capture('before-person-request');
      return usable;
    })()`), true, 'the real G2 approval control is usable at 375px');
    await chrome.stable('window.__holdNextIntent = true');
    await chrome.click("document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    await chrome.waitFor("typeof window.__releaseHeldIntent === 'function' || document.querySelector('#spec-detail .spec-feedback.no')");
    assert.equal(await chrome.stable("typeof window.__releaseHeldIntent"), 'function', 'the row decision reaches the sealed request transport instead of the refused generic API');
    await chrome.waitFor("document.querySelector('#spec-detail .spec-feedback')?.textContent.trim() === 'Recording decision…'");
    await chrome.stable('window.__releaseHeldIntent()');
    await chrome.waitFor("document.querySelector('#spec-detail .spec-feedback') && document.querySelector('#spec-detail .spec-feedback').textContent.trim() !== 'Recording decision…'");
    assert.deepEqual(intents.at(-1), { verb: 'spec-approve', args: { ids: 'G2' } }, 'the detail click creates the exact second literal intent');
    await chrome.waitFor("data?.project?.personRequests?.length === 2 && document.querySelector('[data-person-request=\"request-2\"] .request-status')?.textContent === 'Waiting'");
    assert.match(await chrome.stable("document.querySelector('#spec-detail .spec-feedback')?.textContent.trim() || ''"), /G2/);
    const afterApproval = JSON.parse(await chrome.stable(`JSON.stringify({ root: view.root, row: view.row.spec, scroll: window.scrollY, rowTop: document.querySelector('#spec-list [data-row=\"spec:G2\"]')?.getBoundingClientRect().top, selected: document.querySelector('#spec-list [data-row=\"spec:G2\"]')?.classList.contains('on'), visible: (() => { const row = document.querySelector('#spec-list [data-row=\"spec:G2\"]')?.getBoundingClientRect(); return !!row && row.top >= 0 && row.bottom <= innerHeight; })(), browserTrace: window.__personRequestReadingTrace?.serialize() ?? null })`));
    t.diagnostic(`person-request reading capture: ${JSON.stringify({ clocks: { browser: 'performance.now()', fixture: 'Date.now()' }, reading, afterApproval, requestTimeline })}`);
    diagnosticEmitted = true;
    assert.deepEqual([afterApproval.root, afterApproval.row, afterApproval.selected], [reading.root, 'G2', true], 'the request keeps the selected board and G2 row');
    assert.ok(Math.abs(afterApproval.rowTop - reading.rowBox.top) <= 1, 'the request keeps the row at the same viewport reading position');
    assert.equal(afterApproval.visible, true, 'G2 remains visible beside its inline feedback');
    assert.deepEqual(intents.at(-1), { verb: 'spec-approve', args: { ids: 'G2' } });
    assert.equal(await chrome.stable("data.project.spec.find(row => row.id === 'G2').decision === undefined"), true, 'waiting for a request never approves the row optimistically');
    await chrome.stable("window.__setPersonRequest('request-2', 'done')");
    assert.match(await chrome.stable("document.querySelector('#spec-detail .spec-feedback')?.textContent || ''"), /^Done/, 'the same row feedback follows a matched done receipt');
    await chrome.stable("window.__setPersonRequest('request-2', 'refused', { code: 'REQUEST_DECLINED', message: 'Keep the row draft.', next: 'Ask the coordinator for the next step.' })");
    assert.match(await chrome.stable("document.querySelector('#spec-detail .spec-feedback.no')?.textContent || ''"), /Refused[\s\S]*REQUEST_DECLINED[\s\S]*Keep the row draft\.[\s\S]*Ask the coordinator/, 'the same row retains the original refusal and next step');
    await chrome.stable("window.__setPersonRequest('request-2', 'waiting')");

    const ids = JSON.parse(await chrome.stable('JSON.stringify(data.project.personRequests.map(row => row.id))'));
    assert.deepEqual(ids, ['request-1', 'request-2']);
    assert.ok(await chrome.stable("[...document.querySelectorAll('[data-person-request]')].length === 2 && [...document.querySelectorAll('[data-person-request]')].every(node => node.querySelector('.request-status').textContent === 'Waiting')"), 'waiting receipts render from API state');

    await t.test('a late earlier transport call is not counted as a refused write [H12]', { timeout: 30_000 }, async () => {
      /** Keep only calls with a write shape; unrelated earlier reads must not enter this count. */
      const writes = async () => JSON.parse(await chrome.stable(`JSON.stringify(window.__transportCalls.filter(call => call.body !== null || call.path.split('?')[0].endsWith('/moves')))`));
      const earlierPath = await chrome.stable(`boardPath(view.root) + '/state?lateEarlier=406'`);
      const beforeAllCalls = JSON.parse(await chrome.stable('JSON.stringify(window.__transportCalls)'));
      const beforeWrites = await writes();
      await chrome.stable(`window.__queueEarlierTransportCall(${JSON.stringify(earlierPath)})`);
      assert.equal(await chrome.stable('window.__pendingEarlierTransportCalls'), 1, 'the earlier read is held before it reaches the transport');
      assert.equal(await chrome.stable('window.__releaseEarlierTransportCall()'), undefined, 'the earlier read is released after the stale count');
      await chrome.waitFor(`(async () => {
        if (window.__pendingEarlierTransportCalls !== 0) return false;
        const count = window.__transportCalls.length;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return window.__pendingEarlierTransportCalls === 0 && count === window.__transportCalls.length;
      })()`);
      assert.equal(await chrome.stable('window.__lateEarlierTransportError'), null, 'the earlier read completed successfully');
      const afterEarlierCalls = JSON.parse(await chrome.stable('JSON.stringify(window.__transportCalls)'));
      assert.equal(beforeAllCalls.some(call => call.path === earlierPath), false, 'the delayed call was not in the earlier snapshot');
      assert.equal(afterEarlierCalls.filter(call => call.path === earlierPath && call.body === null).length, 1, 'the deliberately delayed earlier read reaches the transport once');
      const afterEarlierWrites = await writes();
      assert.deepEqual(afterEarlierWrites, beforeWrites, `the late read does not change the write-shaped transport calls: ${JSON.stringify(afterEarlierWrites)}`);

      // A generic write and an unknown action are refused before they reach the stand-in transport.
      const beforeRefused = intents.length;
      const beforeTransport = beforeWrites.length;
      const apiRefusal = await chrome.stable(`(async () => { try { await api(boardPath(view.root) + '/moves', { verb: 'shout', args: { to: 'coordinator', text: 'direct writes stay refused' } }); return 'unexpected'; } catch (error) { return error.message; } })()`);
      const execRefusal = await chrome.stable(`(async () => act('exec', { command: 'true' }))()`);
      const afterRefused = await writes();
      assert.equal(afterRefused.length, beforeTransport, `refused writes never reach the browser transport; extra call shapes: ${JSON.stringify(afterRefused.slice(beforeTransport))}`);
      assert.equal(intents.length, beforeRefused, 'refused shapes never reach the request server');
      assert.match(apiRefusal, /read-only view/i);
      assert.equal(execRefusal, false);
    });

    const longTitle = 'Requested item ' + 'abcdefghij'.repeat(24);
    const otherActions = [
      ['add', { lane: 'web', title: longTitle, criterion: 'visible', specs: 'G1', brief: 'requested work' }, { verb: 'add', args: { lane: 'web', title: longTitle, criterion: 'visible', specs: 'G1', brief: 'requested work' } }],
      ['answer', { id: 1, text: 'Ship it' }, { verb: 'answer', item: 1, args: { text: 'Ship it', as: 'person' } }],
      ['hold', { lane: 'web', reason: 'Wait for the decision' }, { verb: 'hold', args: { lane: 'web', reason: 'Wait for the decision' } }],
      ['release', { lane: 'web' }, { verb: 'hold', args: { lane: 'web', off: true } }],
      ['spec-decline', { ids: 'G2', reason: 'Keep the present behavior' }, { verb: 'spec-decline', args: { ids: 'G2', reason: 'Keep the present behavior' } }],
    ];
    for (const [action, args, expected] of otherActions) {
      assert.equal(await chrome.stable(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), true, `${action} is a permitted person request`);
      assert.deepEqual(intents.at(-1), expected, `${action} retains literal public CLI intent`);
    }
    const allActions = [['shout', { to: 'coordinator', text: 'must not send' }], ['spec-approve', { ids: 'G2' }], ...otherActions.map(([action, args]) => [action, args])];

    // The no-capability read-only page and static snapshot cannot send person requests either.
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/without-capability` });
    await chrome.waitFor("typeof data === 'object' && !!data?.project && document.body?.classList.contains('read-only')");
    const beforeDisabled = intents.length;
    await chrome.click("document.querySelector('[data-tab=\"spec\"]')"); await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.waitFor("view.row.spec === 'G2'");
    assert.equal(await chrome.stable(`(async () => decideRow('spec', 'spec-approve', { ids: 'G2' }, document.querySelector('#spec-list [data-row=\"spec:G2\"]')))()`), false, 'the decision handler itself refuses without request capability');
    assert.equal(await chrome.stable('!view.specFeedback'), true, 'a disabled decision refuses before creating decision feedback');
    assert.equal(intents.length, beforeDisabled, 'a direct no-capability decision never reaches the request transport');
    for (const [action, args] of allActions) assert.equal(await chrome.stable(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), false, `${action} stays refused without the capability`);
    assert.equal(intents.length, beforeDisabled, 'read-only without the explicit request capability refuses every action');
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/snapshot` });
    await chrome.waitFor("typeof data === 'object' && !!data?.project && document.body?.classList.contains('snapshot')");
    assert.equal(await chrome.stable(`(async () => decideRow('spec', 'spec-approve', { ids: 'G2' }, null))()`), false, 'the decision handler itself refuses in a snapshot');
    for (const [action, args] of allActions) assert.equal(await chrome.stable(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), false, `${action} stays refused in a snapshot`);
    assert.match(await chrome.stable(`(async () => { try { await api('/api/v1/boards/demo/moves', { verb: 'shout' }); return 'unexpected'; } catch (error) { return error.message; } })()`), /read-only snapshot/i);
    assert.equal(intents.length, beforeDisabled, 'snapshot mode cannot use the explicit request capability');

    // A later actual API read may update status; refusal text is safe text and preserves CLI guidance.
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/` });
    await chrome.waitFor("typeof window.__setPersonRequest === 'function' && !!data?.project");
    await chrome.stable(`window.__setPersonRequest('request-1', 'done')`);
    await chrome.waitFor("document.querySelector('[data-person-request=\"request-1\"]')?.querySelector('.request-status')?.textContent === 'Done'");
    const refusal = '<img src=x onerror=globalThis.requestInjection=true> UNKNOWN_SPEC; run pullboard spec check';
    await chrome.stable(`window.__setPersonRequest('request-2', 'refused', { code: 'UNKNOWN_SPEC', message: ${JSON.stringify(refusal)}, next: 'run pullboard spec check' })`);
    await chrome.waitFor("document.querySelector('[data-person-request=\"request-2\"]')?.textContent.includes('UNKNOWN_SPEC')");
    assert.equal(await chrome.stable("document.querySelector('[data-person-request=\"request-2\"] img') === null"), true, 'refusal guidance is escaped, not interpreted as markup');
    assert.equal(await chrome.stable("document.querySelector('[data-person-request=\"request-2\"] .request-error')?.textContent"), 'UNKNOWN_SPEC ' + refusal, 'the original CLI refusal message stays intact');
    assert.equal(await chrome.stable('globalThis.requestInjection === undefined'), true, 'refusal content cannot execute in the page');
    assert.equal(await chrome.stable("document.querySelector('[data-person-request=\"request-2\"]')?.textContent.includes('run pullboard spec check')"), true);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `${width}px refusal view has no horizontal overflow`);
      const layout = JSON.parse(await chrome.stable(`JSON.stringify({
        statuses: [...document.querySelectorAll('.request-status')].map(node => node.textContent),
        listFits: document.querySelector('.request-list').scrollWidth <= document.querySelector('.request-list').clientWidth,
        readable: [...document.querySelectorAll('.request-label, .request-status, .request-error, .request-next')].every(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && parseFloat(getComputedStyle(node).fontSize) >= 12;
        })
      })`));
      for (const status of ['Waiting', 'Done', 'Refused']) assert.ok(layout.statuses.includes(status), `${width}px renders ${status} from documented request status`);
      assert.equal(layout.listFits, true, `${width}px keeps the request list inside its panel`);
      assert.equal(layout.readable, true, `${width}px keeps request labels and refusal guidance readable`);
    }
    assert.deepEqual(intents, [
      { verb: 'shout', args: { to: 'coordinator', text: 'Please review this item.' } },
      { verb: 'spec-approve', args: { ids: 'G2' } },
      ...otherActions.map(([, , expected]) => expected),
    ]);
    const privatePath = await chrome.stable('boardPath(view.root)');
    const privateState = await (await fetchLive(live.base + privatePath + '/state', { headers: { 'x-pullboard-key': live.key } })).json();
    assert.equal(privateState.state.items.length, 1, 'the stand-in request transport never executes an item move on the real board');
    assert.equal(privateState.state.holds.length, 0, 'the request transport never changes a real lane hold');
    assert.equal(privateState.state.shouts.length, 1, 'the request transport never posts a direct shout');
  } finally {
    if (chrome) {
      if (!diagnosticEmitted) {
        try {
          const browserTrace = await chrome.stable('window.__personRequestReadingTrace?.serialize() ?? null');
          t.diagnostic(`person-request reading capture on original outcome: ${JSON.stringify({ clocks: { browser: 'performance.now()', fixture: 'Date.now()' }, requestTimeline, browserTrace })}`);
        } catch (error) {
          t.diagnostic(`person-request reading capture unavailable: ${error.name}: ${error.message}; fixture timeline: ${JSON.stringify(requestTimeline)}`);
        }
      }
      await chrome.stable('window.__personRequestReadingTrace?.dispose(); delete window.__personRequestReadingTrace').catch(() => undefined);
      chrome.socket.close();
      await stopOwnedChrome(chrome.child, chrome.stopped);
    }
    await new Promise((resolve) => pageServer.close(resolve));
    await live.stop();
  }
});
