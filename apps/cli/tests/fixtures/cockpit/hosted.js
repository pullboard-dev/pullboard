/** @pullboard-test-gui */
/** Real relay browser journeys and their owned setup [N26]. */
import assert from 'node:assert/strict';
import {
  createServer,
  request,
} from 'node:http';
import { drainJourneyTasks } from './journey/deadline.js';
import { createRelayBrowserHandler } from '../../../../relay/index.js';
import { fetchLive } from './harness.js';

export const JOURNEY_HOSTED = 'https://app.pullboard.dev';
export const JOURNEY_LOCAL = 'http://127.0.0.1:4890';

/** Serve the relay's real browser page and proxy its API to the loopback relay fixture. */
export async function journeyRelaySite(box, localOrigin) {
  const browser = createRelayBrowserHandler({
    async authenticate(req) {
      const token = /(?:^|;\s*)pb_session=([^;]+)/u.exec(req.headers.cookie || '')?.[1];
      if (!token) return { kind: 'anonymous' };
      try { return await box.auth.authenticate(token); } catch { return { kind: 'anonymous' }; }
    },
  });
  const server = createServer((req, res) => {
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, headers, ...rest) => {
      if (headers && !Array.isArray(headers)) {
        const csp = Object.keys(headers).find((name) => name.toLowerCase() === 'content-security-policy');
        if (csp) headers[csp] = headers[csp].replace("connect-src 'self'", "connect-src 'self' " + localOrigin);
      }
      return writeHead(status, headers, ...rest);
    };
    void (async () => {
      if (await browser(req, res)) return;
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': JOURNEY_HOSTED,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': req.headers['access-control-request-headers'] || 'content-type',
          'access-control-allow-private-network': 'true', vary: 'Origin',
        });
        return res.end();
      }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !['host', 'connection', 'content-length'].includes(name.toLowerCase())));
      // As in the real exit journey, translate only the private upstream's configured origin.
      headers.origin = box.origin;
      const upstream = request(new URL(req.url, box.origin), { method: req.method, headers, agent: false }, (reply) => {
        const responseHeaders = Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !['connection', 'transfer-encoding', 'keep-alive', 'access-control-allow-origin', 'access-control-allow-credentials'].includes(name.toLowerCase())));
        responseHeaders['access-control-allow-origin'] = JOURNEY_HOSTED;
        responseHeaders['access-control-allow-credentials'] = 'true';
        responseHeaders.vary = 'Origin';
        res.writeHead(reply.statusCode || 502, responseHeaders);
        reply.pipe(res);
      });
      res.once('close', () => upstream.destroy());
      upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

/** Route the hosted page and its fixed loopback discovery through owned fixture servers. */
export async function interceptJourneyOrigins(chrome, site, view, { deadline: currentDeadline, liveStreams = false } = {}) {
  const failures = [];
  let failureCount = 0;
  const tasks = [];
  const interceptions = [];
  let stopping = false;
  const byNetworkRequest = new Map();
  const earlyNetworkFailures = new Map();
  const networkFailureWaiters = new Set();
  const heldResponses = [];
  const releaseHeldResponses = new Set();
  /** Keep bounded CDP code/message detail without retaining unrelated protocol payloads. */
  function safeProtocolError(error) {
    let detail = error?.message ?? error;
    if (typeof detail === 'string') {
      try { detail = JSON.parse(detail); } catch { /* Keep ordinary Error messages below. */ }
    }
    if (detail && typeof detail === 'object') {
      const message = String(detail.message ?? 'unknown CDP error');
      return {
        ...(Number.isInteger(detail.code) ? { code: detail.code } : {}),
        message: /^[A-Za-z0-9 _.:/-]{1,180}$/u.test(message) ? message : '<redacted protocol error>',
      };
    }
    const message = String(detail ?? 'unknown error');
    return /^[A-Za-z0-9 _.:/-]{1,180}$/u.test(message) ? message : '<redacted protocol error>';
  }
  /** Describe only an owned fixture origin and a query-free path with board identities redacted. */
  function safeRequestAddress(url) {
    const address = new URL(url);
    const origin = address.origin === JOURNEY_HOSTED ? 'hosted'
      : address.origin === JOURNEY_LOCAL ? 'loopback-discovery'
        : address.origin === view.base ? 'local-view' : 'other';
    const path = address.pathname.replace(/\/api\/v1\/boards\/[0-9a-f]{32}(?=\/|$)/gu, '/api/v1/boards/<board>');
    return { origin, path };
  }
  /** Return request evidence without URL queries, headers, cookies, bodies or pairing values. */
  function safeInterception(record) {
    return {
      fetchRequestId: record.fetchRequestId,
      networkId: record.networkId ?? null,
      resourceType: record.resourceType ?? null,
      ...record.address,
      method: record.method,
      stage: record.stage,
      timing: record.timing,
      stopObserved: record.stopObserved,
      completionTiming: record.completionTiming ?? null,
      networkFailureTiming: record.networkFailureTiming ?? null,
      responseStatus: record.responseStatus ?? null,
      liveStream: record.liveStream === true,
      bodyCompleted: record.bodyCompleted,
      bodyBytes: record.bodyBytes,
      bodyBytesCapped: record.bodyBytesCapped,
      completionAttempts: record.completionAttempts,
      completion: record.completion ?? null,
      networkFailure: record.networkFailure ?? null,
      completed: record.completed,
      browserCanceled: record.browserCanceled === true,
      terminalCancellation: record.terminalCancellation === true,
      cancellationCorrelationExpired: record.cancellationCorrelationExpired === true,
    };
  }
  /** Bound diagnostics to failed/incomplete requests and a short recent tail. */
  function safeTrace() {
    const incomplete = interceptions.filter((record) => !isAccountedRequest(record));
    const canceledCount = interceptions.filter((record) => isConfirmedBrowserCancellation(record)).length;
    const failed = interceptions.filter((record) => record.failure).slice(0, 20);
    const canceled = interceptions.filter(isConfirmedBrowserCancellation).slice(0, 20);
    const relevant = new Set([...failed, ...incomplete.slice(0, 20), ...canceled, ...interceptions.slice(-8)]);
    return {
      requestCount: interceptions.length,
      liveStreamCount: interceptions.filter((record) => record.liveStream === true).length,
      failureCount,
      incompleteCount: incomplete.length,
      confirmedBrowserCancellationCount: canceledCount,
      requests: [...relevant].map(safeInterception),
      failures: failures.slice(0, 20),
    };
  }
  /** Send exactly one Fetch completion for a paused request and retain its protocol outcome. */
  async function completePausedRequest(record, method, params) {
    assert.equal(String(params.requestId), record.fetchRequestId, 'Fetch completion belongs to this exact paused request');
    if (record.completionAttempts === 0 && isConfirmedBrowserCancellation(record)) return;
    record.completionAttempts += 1;
    if (record.completionAttempts !== 1) {
      record.stage = 'duplicate-completion-refused';
      throw new Error('a paused request received more than one Fetch completion command');
    }
    record.completionTiming = stopping ? 'during-stop' : 'active';
    record.completion = { method, commandSent: true, status: 'pending', timing: record.completionTiming };
    record.stage = 'completion-command-sent';
    try {
      await chrome.send(method, params);
      record.completion.status = 'resolved';
      record.completed = true;
      record.stage = 'completed';
    } catch (error) {
      record.completion.status = 'rejected';
      record.completion.error = safeProtocolError(error);
      record.stage = 'completion-command-rejected';
      throw error;
    }
  }
  /** Consider only one rejected fulfill for this exact owned request for bounded cancellation correlation. */
  function isAbortCompletionCandidate(record) {
    const error = record.completion?.error;
    return record.networkId !== null && record.address.origin !== 'other'
      && record.completion?.method === 'Fetch.fulfillRequest'
      && record.completionAttempts === 1
      && record.completion?.status === 'rejected'
      && error?.code === -32602
      && (error.message === 'Invalid InterceptionId.' || error.message === 'Invalid InterceptionId');
  }
  /** Recognize the candidate only after this request's own matching-phase browser cancellation arrives. */
  function isObservedAbortCompletionRace(record) {
    return isAbortCompletionCandidate(record) && record.browserCanceled === true
      && record.networkFailure?.canceled === true
      && record.networkFailureTiming === record.completionTiming;
  }
  /** Count only a completion or the exactly correlated browser-abort terminal outcome. */
  function isConfirmedBrowserCancellation(record) {
    if (!record.terminalCancellation || !record.browserCanceled || !record.networkId || record.address.origin === 'other' || record.networkFailure?.canceled !== true) return false;
    if (record.completionAttempts === 0) return true;
    return isObservedAbortCompletionRace(record);
  }
  /** Require every paused request to finish once or meet the narrow cancellation rule. */
  function isAccountedRequest(record) {
    return (record.completed && record.completionAttempts === 1) || isConfirmedBrowserCancellation(record);
  }
  /** Mark a request terminally cancelled only when its own network event confirms the abort. */
  function markObservedAbort(record) {
    record.browserCanceled = true;
    if (record.completed) return;
    record.terminalCancellation = true;
    record.stage = 'browser-cancelled';
    record.abortController?.abort();
    record.releaseHeldResponse?.();
  }
  /** Drain all dynamic batches against the caller's one absolute cleanup deadline. */
  async function drainTasks() {
    return drainJourneyTasks(tasks, currentDeadline());
  }
  /** Abort only outbound reads and release holds owned by this private fixture after failure. */
  function cancelOwned(reason) {
    for (const held of heldResponses.splice(0)) held.cancel();
    for (const release of releaseHeldResponses) release();
    const reads = [];
    for (const record of interceptions) {
      record.abortController?.abort(reason);
      if (record.reader) reads.push(record.reader.cancel());
    }
    return Promise.allSettled(reads);
  }
  /** Retain cancellation and error details keyed only by the ephemeral CDP network id. */
  function onNetworkFailure(params) {
    const details = {
      type: String(params.type ?? '').slice(0, 40),
      errorText: /^[A-Za-z0-9_:.-]{1,100}$/u.test(params.errorText ?? '') ? params.errorText : '<redacted>',
      canceled: Boolean(params.canceled),
      timing: stopping ? 'during-stop' : 'active',
      ...(params.blockedReason ? { blockedReason: String(params.blockedReason).slice(0, 60) } : {}),
    };
    const id = String(params.requestId ?? '');
    const records = byNetworkRequest.get(id);
    if (!records?.length) {
      const prior = earlyNetworkFailures.get(id) ?? [];
      prior.push(details);
      earlyNetworkFailures.set(id, prior);
      return;
    }
    for (const record of records) {
      record.networkFailure = details;
      record.networkFailureTiming = details.timing;
      if (details.canceled) markObservedAbort(record);
    }
    for (const check of networkFailureWaiters) check();
  }
  /** Wait for a correlated network failure without retaining request credentials or bodies. */
  function waitForNetworkFailure(matches) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { // budget: 10s hang ceiling for the private request-failure handshake; journey deadline owns total runtime.
        networkFailureWaiters.delete(check);
        reject(new Error('the owned browser request did not report its expected network failure within 10 seconds'));
      }, 10_000);
      function check() {
        const record = interceptions.find((entry) => matches(entry) && entry.networkFailure);
        if (!record) return;
        clearTimeout(timer);
        networkFailureWaiters.delete(check);
        resolve(safeInterception(record));
      }
      networkFailureWaiters.add(check);
      check();
    });
  }
  const holdNextResponse = (matches) => {
    let entry;
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { // budget: 10s hang ceiling for the fixture to observe one held response; journey deadline owns total runtime.
        const index = heldResponses.indexOf(entry);
        if (index !== -1) heldResponses.splice(index, 1);
        reject(new Error('The real API response did not reach the fixture hold within 10 seconds.'));
      }, 10_000);
      entry = {
        matches,
        resolve(value) { clearTimeout(timer); resolve(value); },
        cancel() { clearTimeout(timer); reject(new Error('The fixture closed before the held API response arrived.')); },
      };
      heldResponses.push(entry);
    });
    void pending.catch(() => {});
    return pending;
  };
  const networkListener = ({ data }) => {
    try {
      const message = JSON.parse(String(data));
      if (message.method === 'Network.loadingFailed') onNetworkFailure(message.params);
    } catch (error) {
      failureCount += 1;
      if (failures.length < 20) failures.push({ error: safeProtocolError(error), request: null });
    }
  };
  const listener = ({ data }) => {
    let message;
    try { message = JSON.parse(String(data)); }
    catch (error) {
      failureCount += 1;
      if (failures.length < 20) failures.push({ error: safeProtocolError(error), request: null });
      return;
    }
    if (message.method !== 'Fetch.requestPaused') return;
    tasks.push((async () => {
      let record;
      try {
        const { requestId, networkId, resourceType, request: asked } = message.params;
        record = {
          fetchRequestId: String(requestId),
          networkId: networkId ? String(networkId) : null,
          resourceType: String(resourceType ?? '').slice(0, 40),
          address: {
            ...safeRequestAddress(asked.url),
            fixtureCancelProbe: new URL(asked.url).search === '?fixture_cancel=1',
          },
          method: String(asked.method ?? '').slice(0, 16),
          stage: 'paused',
          completionAttempts: 0,
          completion: null,
          completed: false,
          responseStatus: null,
          bodyCompleted: false,
          bodyBytes: 0,
          bodyBytesCapped: false,
          timing: stopping ? 'during-stop' : 'active',
          stopObserved: false,
          networkFailure: null,
        };
        interceptions.push(record);
        if (record.networkId) {
          const attached = byNetworkRequest.get(record.networkId) ?? [];
          attached.push(record);
          byNetworkRequest.set(record.networkId, attached);
          const earlier = earlyNetworkFailures.get(record.networkId);
          if (earlier?.length) {
            record.networkFailure = earlier.at(-1);
            record.networkFailureTiming = record.networkFailure.timing;
            if (record.networkFailure.canceled) markObservedAbort(record);
            for (const check of networkFailureWaiters) check();
          }
        }
        const address = new URL(asked.url);
        const base = address.origin === JOURNEY_HOSTED ? site.base
          : [JOURNEY_LOCAL, view.base].includes(address.origin) ? view.base : null;
        if (!base) {
          record.stage = 'reject-foreign-origin';
          await completePausedRequest(record, 'Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
          return;
        }
        const accept = Object.entries(asked.headers).find(([name]) => name.toLowerCase() === 'accept')?.[1] || '';
        if (liveStreams && asked.method === 'GET' && address.pathname.startsWith('/api/')
          && (address.pathname.endsWith('/events') || String(accept).includes('text/event-stream'))) {
          // A finite fulfilled first chunk is EOF, not a live stream: it creates artificial reconnect traffic.
          // Keep the real stream open through the owned HTTP proxy, as the accepted exit journey does.
          record.liveStream = true;
          await completePausedRequest(record, 'Fetch.continueRequest', {
            requestId, url: base + address.pathname + address.search,
            headers: Object.entries(asked.headers).filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase()))
              .map(([name, value]) => ({ name, value })),
          });
          return;
        }
        record.stage = 'fetching-owned-fixture';
        record.abortController = new AbortController();
        if (record.terminalCancellation) return;
        const headers = Object.fromEntries(Object.entries(asked.headers).filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase())));
        const response = await fetchLive(base + address.pathname + address.search, {
          method: asked.method, headers, redirect: 'manual',
          ...(asked.postData === undefined ? {} : { body: asked.postData }),
          signal: AbortSignal.any([record.abortController.signal, AbortSignal.timeout(10_000)]),
        });
        record.responseStatus = response.status;
        record.stage = 'reading-owned-response';
        let body;
        if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
          const reader = response.body.getReader();
          record.reader = reader;
          try {
            const first = await reader.read();
            body = Buffer.from(first.value || []);
          } finally {
            await reader.cancel();
            record.reader = null;
          }
        } else body = Buffer.from(await response.arrayBuffer());
        record.bodyBytes = Math.min(body.length, 1_000_000);
        record.bodyBytesCapped = body.length > record.bodyBytes;
        record.bodyCompleted = true;
        const heldIndex = heldResponses.findIndex((entry) => entry.matches({ method: asked.method, path: address.pathname, search: address.search, status: response.status }));
        if (heldIndex !== -1) {
          record.stage = 'holding-owned-response';
          const [held] = heldResponses.splice(heldIndex, 1);
          let release;
          const released = new Promise((resume) => {
            release = () => { releaseHeldResponses.delete(release); resume(); };
            releaseHeldResponses.add(release);
          });
          record.releaseHeldResponse = release;
          held.resolve({ status: response.status, release });
          if (record.terminalCancellation) release();
          await released;
          record.releaseHeldResponse = null;
        }
        if (record.terminalCancellation) return;
        await completePausedRequest(record, 'Fetch.fulfillRequest', {
          requestId, responseCode: response.status,
          responseHeaders: [...response.headers].filter(([name]) => !['content-length', 'connection', 'transfer-encoding', 'keep-alive', 'date'].includes(name.toLowerCase())).map(([name, value]) => ({ name, value })),
          body: body.toString('base64'),
        });
      } catch (error) {
        if (record && isConfirmedBrowserCancellation(record) && record.completionAttempts === 0
          && record.abortController?.signal.aborted && error.name === 'AbortError') {
          record.stage = 'browser-cancelled';
          return;
        }
        // CDP may deliver the canceled network event after the command rejection. Only this exact
        // owned single-fulfill error may wait for correlation; expiry or any other outcome remains fatal.
        if (record && isAbortCompletionCandidate(record) && !record.networkFailure) {
          try { await waitForNetworkFailure((entry) => entry === record); }
          catch { record.cancellationCorrelationExpired = true; }
        }
        if (record?.terminalCancellation && isObservedAbortCompletionRace(record)) {
          record.stage = 'browser-cancelled-after-completion-race';
          return;
        }
        if (record) {
          record.stage = record.stage === 'completion-command-rejected' ? record.stage : 'interception-handler-failed';
          record.failure = safeProtocolError(error);
        }
        failureCount += 1;
        if (failures.length < 20) failures.push({ error: safeProtocolError(error), request: record ? safeInterception(record) : null });
      }
    })());
  };
  chrome.socket.addEventListener('message', listener);
  chrome.socket.addEventListener('message', networkListener);
  // Chrome drops a paused request when its document is replaced, and reports no Network.loadingFailed for it (#748),
  // so a read still in flight as the fixture navigates away would be stranded unaccounted. Each hosted document
  // counts its own finite reads and can close to new ones; live streams are continued at once and stay open.
  const { identifier: fetchGate } = await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    if (location.origin !== ${JSON.stringify(JOURNEY_HOSTED)}) return;
    const nativeFetch = window.fetch.bind(window);
    const gate = { closed: false, open: 0 };
    Object.defineProperty(window, '__journeyFetchGate', { value: gate });
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const accept = new Headers(init?.headers ?? (typeof input === 'string' ? undefined : input.headers)).get('accept') || '';
      if (url.pathname.endsWith('/events') || accept.includes('text/event-stream')) return gate.closed ? new Promise(() => {}) : nativeFetch(input, init);
      if (gate.closed) return new Promise(() => {});
      gate.open += 1;
      return nativeFetch(input, init).finally(() => { gate.open -= 1; });
    };
  })()` });
  await chrome.send('Fetch.enable', { patterns: [{ urlPattern: JOURNEY_HOSTED + '/*', requestStage: 'Request' }, { urlPattern: JOURNEY_LOCAL + '/*', requestStage: 'Request' }, { urlPattern: view.base + '/*', requestStage: 'Request' }] });
  /** Close the hosted document to new reads and wait until every read it started has its answer from this fixture. */
  async function quiescePage() {
    if (!(await chrome.stable('(() => { const gate = window.__journeyFetchGate; if (gate) gate.closed = true; return Boolean(gate); })()'))) return;
    await chrome.waitFor('window.__journeyFetchGate.open === 0');
    await drainTasks();
  }
  /** Leave the hosted page for a blank one only once nothing it started is still paused here. */
  async function leavePage() {
    await quiescePage();
    await chrome.send('Page.navigate', { url: 'about:blank' });
    await chrome.waitFor('location.href === "about:blank"');
  }
  const stop = async () => {
    stopping = true;
    for (const record of interceptions) record.stopObserved = true;
    for (const held of heldResponses.splice(0)) held.cancel();
    for (const release of releaseHeldResponses) release();
    const errors = [];
    // Close the page to new reads and settle the ones it started before leaving it, so no read is stranded by the
    // navigation; anything still arriving during shutdown is drained instead of escaping to a real origin.
    try { await quiescePage(); } catch (error) { errors.push(error); }
    try { await drainTasks(); } catch (error) { errors.push(error); }
    try {
      await chrome.send('Page.navigate', { url: 'about:blank' });
      await chrome.waitFor('location.href === "about:blank"');
    } catch (error) { errors.push(error); }
    try { await drainTasks(); } catch (error) { errors.push(error); }
    try { await chrome.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: fetchGate }); } catch (error) { errors.push(error); }
    try { await chrome.send('Fetch.disable'); } catch (error) { errors.push(error); }
    try { await drainTasks(); } catch (error) { errors.push(error); }
    finally {
      chrome.socket.removeEventListener('message', listener);
      chrome.socket.removeEventListener('message', networkListener);
    }
    if (errors.length) {
      const summaries = errors.map((error) => {
        const safe = safeProtocolError(error);
        return (typeof safe === 'string' ? safe : safe.message).slice(0, 180);
      });
      throw new AggregateError(errors, 'journey interception cleanup failed: ' + summaries.join(' | '));
    }
    const incomplete = interceptions.filter((record) => !isAccountedRequest(record));
    const diagnostic = JSON.stringify(safeTrace());
    assert.equal(failureCount, 0, 'the hosted and loopback fixture requests complete; safe interception trace: ' + diagnostic);
    assert.equal(incomplete.length, 0, 'each paused request completes once or has its own confirmed browser cancellation; safe interception trace: ' + diagnostic);
  };
  stop.cancelOwned = cancelOwned;
  stop.leavePage = leavePage;
  /** Observe terminal request outcomes after the caller releases or aborts its owned inputs. */
  stop.settled = () => Promise.allSettled(tasks);
  stop.holdNextResponse = holdNextResponse;
  stop.waitForNetworkFailure = waitForNetworkFailure;
  stop.trace = safeTrace;
  return stop;
}
