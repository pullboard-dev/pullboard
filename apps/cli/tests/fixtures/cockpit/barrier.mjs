/**
 * Draft only: hold one real local-board HTTP response after the server has processed a prior shout.
 * This is a controlled overlap mechanism, not evidence that either earlier failure followed it.
 */
export async function holdPriorShoutResponse(chrome, expectedText) {
  const trace = [];
  const candidateRequests = new Set();
  const paused = new Map();
  const continuations = new Set();
  let heldResponse = null;
  let heldResolve;
  let heldReject;
  let released = false;
  const held = new Promise((resolve, reject) => { heldResolve = resolve; heldReject = reject; });
  held.catch(() => {}); // A setup failure is also reported through trace/cleanup if the caller is unwinding.

  /** Record only bounded response metadata and the prior shout identity; never retain API secrets. */
  const note = (entry) => {
    if (trace.length < 40) trace.push({ wallAt: Date.now(), ...entry });
    else trace.dropped = (trace.dropped ?? 0) + 1;
  };

  /** Continue any non-target intercepted stage without changing its request or response. */
  const continueStage = (requestId, responseStage) => {
    const observedStage = paused.get(requestId);
    const operation = (async () => {
      await chrome.send(responseStage ? 'Fetch.continueResponse' : 'Fetch.continueRequest', { requestId });
      // CDP may report the response pause before continueRequest's command reply; do not erase it.
      if (paused.get(requestId) === observedStage) paused.delete(requestId);
    })();
    continuations.add(operation);
    operation.then(() => continuations.delete(operation), () => continuations.delete(operation));
    return operation;
  };

  /** Identify the preceding real shout at request stage and hold its response only after HTTP completion. */
  const onMessage = ({ data }) => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message.method !== 'Fetch.requestPaused') return;
    const event = message.params;
    const requestId = event.requestId;
    const responseStage = Number.isInteger(event.responseStatusCode) || Object.hasOwn(event, 'responseErrorReason');
    paused.set(requestId, { responseStage });
    if (!responseStage) {
      let match = false;
      try {
        const url = new URL(event.request.url);
        const body = JSON.parse(event.request.postData ?? 'null');
        match = event.request.method === 'POST'
          && url.hostname === '127.0.0.1'
          && /^\/api\/v1\/boards\/[^/]+\/moves$/.test(url.pathname)
          && body?.verb === 'shout'
          && body?.args?.text === expectedText;
      } catch { /* A non-JSON or non-matching move continues untouched. */ }
      if (match) {
        candidateRequests.add(requestId);
        note({ stage: 'request-continued', method: 'POST', path: '/api/v1/boards/:id/moves', verb: 'shout', matchingText: true });
      }
      void continueStage(requestId, false).catch((error) => {
        note({ stage: 'request-continue-error', error: `${error.name}: ${error.message}` });
        heldReject(error);
      });
      return;
    }
    const heldCandidate = candidateRequests.has(requestId) && !released && event.responseStatusCode === 200;
    if (heldCandidate) {
      candidateRequests.delete(requestId);
      note({ stage: 'response-held', status: event.responseStatusCode, path: '/api/v1/boards/:id/moves' });
      heldResponse = { requestId, status: event.responseStatusCode };
      heldResolve({ ...heldResponse, trace });
      return;
    }
    if (candidateRequests.has(requestId)) {
      candidateRequests.delete(requestId);
      note({ stage: 'target-response-not-held', status: event.responseStatusCode ?? null,
        error: event.responseErrorReason ?? null });
      heldReject(new Error('The target shout did not return HTTP 200 at the intercepted response stage.'));
    }
    void continueStage(requestId, true).catch((error) => {
      note({ stage: 'response-continue-error', error: `${error.name}: ${error.message}` });
      heldReject(error);
    });
  };

  chrome.socket.addEventListener('message', onMessage);
  try {
    await chrome.send('Fetch.enable', { patterns: [
      { urlPattern: '*://127.0.0.1:*/api/v1/boards/*/moves', requestStage: 'Request' },
      { urlPattern: '*://127.0.0.1:*/api/v1/boards/*/moves', requestStage: 'Response' },
    ] });
  } catch (error) {
    chrome.socket.removeEventListener('message', onMessage);
    await chrome.send('Fetch.disable').catch(() => {});
    throw error;
  }

  return {
    held,
    trace,
    /** Wait only within the caller's already declared browser-wait budget. */
    async waitUntilHeld(timeoutMs) {
      let timer;
      try {
        return await Promise.race([held, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('the prior shout response was not intercepted within the existing browser-wait budget')),
            timeoutMs); // budget: reuses the journey's existing wait ceiling; not a new speed target.
        })]);
      } finally { clearTimeout(timer); }
    },
    /** Release the actual server response unchanged after the newer answer draft is recorded. */
    async release(timeoutMs) {
      const response = await this.waitUntilHeld(timeoutMs);
      if (released) throw new Error('The prior shout response was already released.');
      released = true;
      note({ stage: 'response-released', status: response.status, path: '/api/v1/boards/:id/moves' });
      await continueStage(response.requestId, true);
      return response;
    },
    /** Always drain any paused response/request and disable this one-fixture interception. */
    async dispose() {
      const cleanupErrors = [];
      try {
        if (!released && heldResponse && paused.has(heldResponse.requestId)) {
          released = true;
          note({ stage: 'response-released-during-cleanup', status: heldResponse.status,
            path: '/api/v1/boards/:id/moves' });
          await continueStage(heldResponse.requestId, true);
        }
      for (const [requestId, state] of [...paused]) {
          try { await continueStage(requestId, state.responseStage); }
          catch (error) {
            cleanupErrors.push(`${error.name}: ${error.message}`);
            note({ stage: 'cleanup-continue-error', error: `${error.name}: ${error.message}` });
          }
        }
      } catch (error) {
        cleanupErrors.push(`${error.name}: ${error.message}`);
        note({ stage: 'cleanup-release-error', error: `${error.name}: ${error.message}` });
      } finally {
        chrome.socket.removeEventListener('message', onMessage);
        try { await chrome.send('Fetch.disable'); }
        catch (error) {
          cleanupErrors.push(`${error.name}: ${error.message}`);
          note({ stage: 'fetch-disable-error', error: `${error.name}: ${error.message}` });
        }
      }
      await Promise.allSettled([...continuations]);
      return { complete: paused.size === 0 && cleanupErrors.length === 0 && (trace.dropped ?? 0) === 0,
        trace: [...trace], dropped: trace.dropped ?? 0, cleanupErrors };
    },
  };
}
