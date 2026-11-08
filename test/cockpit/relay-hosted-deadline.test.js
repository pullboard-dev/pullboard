// pullboard: browser
/** @pullboard-test-gui */
/** Real relay browser journeys and their owned setup [N26]. */
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { createJourneyDeadline, drainJourneyTasks, journeyDeferred } from './journey-deadline.js';
import { machine, startView, startSnapshotChrome } from './fixture.js';
import { JOURNEY_HOSTED, interceptJourneyOrigins } from './relay-hosted-fixture.js';

test('the hosted journey owns startup resources before readiness [N26,C7]', { timeout: 5_000 }, async () => {
  const box = machine();
  const neverReady = join(box.dir, 'never-ready.js');
  writeFileSync(neverReady, 'setInterval(() => {}, 1000);\n');
  const viewAbort = new AbortController();
  const viewReason = new Error('stop the owned view before its URL');
  let stopView;
  const startingView = startView(box, { bin: neverReady, signal: viewAbort.signal, onOwned(stop) {
    stopView = stop;
    viewAbort.abort(viewReason);
  } });
  assert.equal(typeof stopView, 'function', 'the view is owned synchronously after spawn');
  try { await assert.rejects(startingView, error => error === viewReason); }
  finally { viewAbort.abort(viewReason); await stopView(); }
  assert.strictEqual(stopView(), stopView(), 'repeated view cleanup shares the same completed stop');

  const sleeper = join(box.dir, 'owned-browser-startup');
  writeFileSync(sleeper, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(sleeper, 0o700);
  const browserAbort = new AbortController();
  const browserReason = new Error('stop the owned browser before its port');
  const stops = [];
  const startingBrowser = startSnapshotChrome(sleeper, join(box.dir, 'abort-browser-profile'), {
    signal: browserAbort.signal, onOwned(stop) {
      stops.push(stop);
      browserAbort.abort(browserReason);
    },
  });
  assert.equal(stops.length, 1, 'the browser group is owned synchronously after spawn');
  try { await assert.rejects(startingBrowser, error => error === browserReason); }
  finally { browserAbort.abort(browserReason); await Promise.allSettled(stops.map(stop => stop())); }
  assert.equal(stops.length, 1, 'aborting startup never launches a retry');
  assert.strictEqual(stops[0](), stops[0](), 'repeated browser cleanup shares one completed stop');
});

test('the hosted journey names its phase and stops within its own deadline [N26,H5,C7]', { timeout: 5_000 }, async (t) => {
  const acknowledged = journeyDeferred();
  let heldResponse;
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.flushHeaders();
    heldResponse = response;
    acknowledged.resolve();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const site = { base: `http://127.0.0.1:${server.address().port}` };
  const view = { base: 'http://127.0.0.1:1' };
  const chrome = {
    socket: new EventTarget(),
    async send() { return {}; },
    async stable() { return false; },
    async waitFor() { return true; },
  };
  let deadline;
  let stop;
  let stopping;
  let fallbackTimer;
  const releaseSse = () => {
    if (!heldResponse || heldResponse.destroyed || heldResponse.writableEnded) return;
    heldResponse.write('data: release\n\n');
    heldResponse.end();
  };

  try {
    stop = await interceptJourneyOrigins(chrome, site, view, { deadline: () => deadline });
    chrome.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      method: 'Fetch.requestPaused',
      params: {
        requestId: 'fixture-fetch-request',
        networkId: 'fixture-network-request',
        resourceType: 'EventSource',
        request: {
          url: `${JOURNEY_HOSTED}/api/v1/boards/${'a'.repeat(32)}/events`,
          method: 'GET',
          headers: {},
        },
      },
    }) }));

    // This handshake proves the real loopback server sent headers while withholding the first SSE body chunk.
    await acknowledged.promise;
    deadline = createJourneyDeadline({ timeoutMs: 50, onTimeout: () => stop.cancelOwned() });
    deadline.setPhase('held interception');
    deadline.setCleanupStage('stop-interception');

    // Hang ceiling only: the pre-deadline implementation eventually drains when this exact response is released.
    fallbackTimer = setTimeout(releaseSse, 250);
    stopping = stop();
    await assert.rejects(stopping, (error) => {
      const pending = [error];
      const seen = new Set();
      while (pending.length) {
        const current = pending.pop();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        if (current.name === 'JourneyDeadlineExceededError'
            && current.phase === 'held interception'
            && current.cleanupStage === 'stop-interception') {
          assert.match(current.message, /phase held interception/u,
            'the deadline names the phase in its actual failure text');
          assert.match(current.message, /cleanup stage stop-interception/u,
            'the deadline names the cleanup stage in its actual failure text');
          return true;
        }
        if (Array.isArray(current.errors)) pending.push(...current.errors);
        if (current.cause) pending.push(current.cause);
      }
      return false;
    }, 'the held EventSource is attributed to its phase and the shared deadline');
  } finally {
    clearTimeout(fallbackTimer);
    releaseSse();
    if (stopping) await Promise.allSettled([stopping]);
    if (stop?.settled) await stop.settled();
    deadline?.dispose();
    if (heldResponse && !heldResponse.destroyed) heldResponse.destroy();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  const ordinary = new Error('the owned fixture rejected before its deadline');
  const ordinaryDeadline = createJourneyDeadline({ timeoutMs: 1_000, onTimeout() {} });
  try {
    await assert.rejects(drainJourneyTasks([Promise.reject(ordinary)], ordinaryDeadline),
      error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === ordinary,
      'an ordinary request failure retains its original error instead of becoming a timeout');
  } finally { ordinaryDeadline.dispose(); }
});
