// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Real relay browser journeys and their owned setup [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createServer,
  request,
} from 'node:http';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { performance } from 'node:perf_hooks';
import { press } from '../../../tests/fixtures/cockpit/stable.js';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../../index.js';
import {
  machine,
  project,
  fetchLive,
  startView,
  target,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../../tests/fixtures/cockpit/harness.js';

test('a person request never moves the reading position under a 6× CPU throttle [N26]', { timeout: 120_000 }, async t => { // budget: hang-only ceiling for real Chrome startup, private board setup and the sixfold request journey.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the native sixfold person-request regression');

  const box = machine();
  const requestRows = Array.from({ length: 12 }, (_, index) => `- P${index + 1} [draft, must] Keep the reading position measurable. | gate: test`).join('\n');
  const spec = `# Person request fixture\n\n## G · Goals\n- G1 [approved, must] Existing item remains readable. | gate: test\n${requestRows}\n- G2 [draft, must] The person can approve this row. | gate: test\n`;
  const app = project(box, 'person request growth at sixfold CPU', spec);
  box.run(app.repo, 'add', 'web', 'Existing private item', '--specs', 'G1', '--criterion', 'remains readable');
  const live = await startView(box);
  const intents = [];
  const records = [];
  const requestTimeline = [];
  let chrome;
  let server;
  let traceArmed = false;
  /** Provide only the sealed person-request intent and actual private board reads. */
  const transportModule = `export async function createTransport() {
    return { async request(path, body) {
      if (body) {
        const response = await fetch('/intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const document = await response.json();
        if (!response.ok) throw new Error(document.error?.message || String(response.status));
        return document;
      }
      const response = await fetch('/fixture' + path);
      const document = await response.json();
      if (!response.ok) throw new Error(document.error?.message || String(response.status));
      return document;
    } };
  }`;
  /** Serve the request receipts while proxying each board read to the real private view. */
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(cockpitPage('', { readOnly: true, requests: true, transportModule: '/transport.js', stylesheet: '/view.css' }));
    if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(transportModule);
    if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' })
      .end(readFileSync(resolve(import.meta.dirname, "../../../../view/src/io/main.css")));
    if (url.pathname === '/intent' && request.method === 'POST') {
      const receivedAt = Date.now();
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const move = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      intents.push(move);
      const row = { id: `request-${intents.length}`, sequence: intents.length, at: new Date(receivedAt).toISOString(), by: 'person', move, status: 'waiting' };
      records.push(row);
      requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-accepted', at: receivedAt, id: row.id, verb: move.verb });
      response.once('finish', () => requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-response-finished', at: Date.now(), id: row.id, status: response.statusCode }));
      return response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ version: 1, event: { event_id: row.sequence, kind: 'request' }, result: { request: row } }));
    }
    if (url.pathname.startsWith('/fixture/')) {
      const receivedAt = Date.now();
      const upstream = await fetchLive(live.base + url.pathname.slice('/fixture'.length) + url.search, { headers: { 'x-pullboard-key': live.key } });
      const body = await upstream.json();
      if (url.pathname.endsWith('/state')) {
        requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-start', at: receivedAt });
        body.state.personRequests = structuredClone(records);
        requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-response', at: Date.now(), status: upstream.status });
      }
      return response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }
    return response.writeHead(404).end();
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${server.address().port}/`, join(box.dir, 'person-request-growth-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true,
      'the 375px person-request view fits the viewport');
    await press(chrome, "document.querySelector('[data-tab=\"shouts\"]')");
    await chrome.stable("document.querySelector('#shout-to').value = 'person'");
    await chrome.stable("document.querySelector('#shout-text').value = 'Should this item ship?'");
    await chrome.stable("document.querySelector('#shout-form').requestSubmit()");
    await chrome.waitFor('data?.project?.personRequests?.length === 1');
    assert.deepEqual(intents[0], { verb: 'shout', args: { to: 'person', text: 'Should this item ship?' } },
      'the initial request is an actual literal person intent');

    await press(chrome, "document.querySelector('[data-tab=\"spec\"]')");
    await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.stable("document.querySelector('#spec-list [data-row=\"spec:G2\"]').scrollIntoView({ block: 'center', behavior: 'instant' })");
    await chrome.waitFor('window.scrollY > 0');
    await press(chrome, "document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.waitFor("view.row.spec === 'G2' && document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    const throttleResponse = await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const throttle = { requestedRate: 6, commandResolved: true, protocolResponse: throttleResponse ?? null,
      computed: JSON.parse(await chrome.stable(`JSON.stringify({ viewport:{ width:innerWidth, height:innerHeight }, dpr:devicePixelRatio,
      body:{ fontSize:getComputedStyle(document.body).fontSize, lineHeight:getComputedStyle(document.body).lineHeight } })`)),
    };
    assert.equal(throttle.requestedRate, 6, 'the real Chrome throttle command requests sixfold CPU slowdown');
    assert.equal(throttle.commandResolved, true, 'the CPU-throttle command is acknowledged before the measured action');
    assert.deepEqual(throttle.computed.viewport, { width: 375, height: 900 }, 'the mutation-time capture uses the required phone viewport');
    const before = JSON.parse(await chrome.stable(`JSON.stringify({ scrollY, requestCount:document.querySelectorAll('#person-requests [data-person-request]').length,
      panel:(()=>{const n=document.querySelector('#person-requests'),r=n.getBoundingClientRect();return{height:r.height,documentTop:r.top+scrollY,overflowAnchor:getComputedStyle(n).overflowAnchor}})(),
      row:(()=>{const n=document.querySelector('#spec-list [data-row=\"spec:G2\"]'),r=n.getBoundingClientRect();return{connected:n.isConnected,top:r.top,documentTop:r.top+scrollY,height:r.height}})(),
      approveHeight:document.querySelector('#spec-detail button[data-row-decision=\"approve\"]').getBoundingClientRect().height })`));
    assert.equal(before.requestCount, 1, 'the person panel begins with one existing request');
    assert.ok(before.approveHeight >= 44, 'the actual approval target remains usable');
    assert.ok(before.scrollY > 0 && before.row.connected, 'the selected G2 row starts at a real scrolled reading position');
    await chrome.stable(`(() => {
      const box = () => {
        const panel=document.querySelector('#person-requests'), row=document.querySelector('#spec-list [data-row="spec:G2"]');
        const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{connected:node.isConnected,top:r.top,bottom:r.bottom,documentTop:r.top+scrollY,height:r.height}};
      return { at:performance.now(), scrollY, pageHeight:document.documentElement.scrollHeight,
          requestCount:panel.querySelectorAll('[data-person-request]').length, panel:rect(panel), row:rect(row),
          pageOverflowAnchor:getComputedStyle(document.documentElement).overflowAnchor, selected:view.row.spec };
      };
      const nativeScrollTo=window.scrollTo;
      const trace=window.__personRequestGrowthTrace={ initial:box(), events:[], mutationBatches:0, growth:null, scrollToCalls:[], preRestore:null, disposed:false };
      trace.snapshot=box;
      window.scrollTo=function(...args){
        const before=box();
        const growingPanel=before.requestCount===2 && before.panel.height>trace.initial.panel.height;
        if(growingPanel && !trace.preRestore)trace.preRestore={args,before};
        const result=nativeScrollTo.apply(window,args);
        const after=box();
        if(trace.scrollToCalls.length<12)trace.scrollToCalls.push({args,before,after});
        if(growingPanel && trace.preRestore && !trace.preRestore.after)trace.preRestore.after=after;
        return result;
      };
      trace.observer=new MutationObserver(changes=>{
        if(trace.disposed)return;
        const relevant=changes.some(change=>{
          const target=change.target.nodeType===1?change.target:change.target.parentElement;
          return target?.closest?.('#person-requests, #spec-list') || [...change.addedNodes,...change.removedNodes].some(node=>
            node.nodeType===1 && (node.matches?.('#person-requests, #spec-list') || node.querySelector?.('#person-requests, #spec-list')));
        });
        if(!relevant)return;
        trace.mutationBatches+=1;
        const sample=box();
        if(trace.events.length<40)trace.events.push(sample);
        if(sample.requestCount===2 && !trace.growth)trace.growth=sample;
      });
      trace.observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true,attributeFilter:['hidden','class','style']});
      trace.dispose=()=>{trace.disposed=true;trace.observer.disconnect();window.scrollTo=nativeScrollTo;};
    })()`);
    traceArmed = true;
    await press(chrome, "document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    await chrome.waitFor("data?.project?.personRequests?.length === 2 && document.querySelector('[data-person-request=\"request-2\"] .request-status')?.textContent === 'Waiting'");
    const capture = JSON.parse(await chrome.stable('JSON.stringify({ ...window.__personRequestGrowthTrace, settled: window.__personRequestGrowthTrace.snapshot() })'));
    assert.ok(capture?.growth, 'the actual second-request DOM mutation captures the panel-growth instant');
    assert.equal(capture.growth.requestCount, 2, 'the captured mutation contains the real second request');
    assert.ok(capture.growth.panel.height > before.panel.height, 'the person panel grew before the browser movement assertion');
    const positions = [capture.initial, ...capture.events, ...capture.scrollToCalls.flatMap(call => [call.before, call.after]), capture.settled];
    for (const position of positions) {
      assert.ok(position.row?.connected, 'the reading row remains present through each redraw and restoration');
      assert.ok(Math.abs(position.row.top - before.row.top) <= 1,
        `the row stays at viewport top ${before.row.top} through request growth: ${JSON.stringify(position)}`);
    }
    assert.equal(capture.growth.selected, 'G2', 'the selected reading row stays the same through panel growth');
    assert.deepEqual(intents[1], { verb: 'spec-approve', args: { ids: 'G2' } }, 'the measured action is the real G2 approval request');
    t.diagnostic(`sixfold person-request growth capture: ${JSON.stringify({ throttle, before, capture, intent:intents[1], timeline:requestTimeline,
      clocks:{ browser:'performance.now()', fixture:'Date.now()' } })}`);
  } finally {
    if (chrome) {
      if (traceArmed) {
        try {
          const trace=await chrome.stable('JSON.stringify(window.__personRequestGrowthTrace ?? null)');
          t.diagnostic(`sixfold person-request growth trace on original outcome: ${trace}`);
        } catch (error) { t.diagnostic(`sixfold person-request trace unavailable: ${error.name}: ${error.message}; timeline=${JSON.stringify(requestTimeline)}`); }
        await chrome.stable('window.__personRequestGrowthTrace?.dispose(); delete window.__personRequestGrowthTrace').catch(() => undefined);
      }
      await chrome.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await new Promise(resolvePromise => server.close(resolvePromise));
    await live.stop();
  }
});
