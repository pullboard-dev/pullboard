// pullboard: browser
/** @pullboard-test-gui */
/** Real native approvals survive page work and keep refusal identity, with every revocation run in process [H15,H12,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayDirectFixture } from './fixtures/relay-direct-fixture.js';
import { closeCellBoard } from '../../../packages/board/tests/fixtures/cell-board.js';
import { openCellBoard } from '../../../packages/board/tests/fixtures/cell-board.js';
import {
  enrollProtocolPhone,
  nativeRevocations,
  pairChromePhone,
  waitFor,
} from './fixtures/relay-phone-fixture.js';
import { findChromeExecutable } from '../../cli/tests/fixtures/relay/browser.js';
import { ENGINE_VERSION } from '../../../packages/state/index.js';

/** Issue a real board-scoped token through the fixture's persistent relay-auth database. */
async function issueToken(box, label) {
  const link = box.readLink();
  const response = await fetch(box.origin + '/auth/tokens', { method: 'POST',
    headers: { authorization: 'Bearer ' + link.token, 'content-type': 'application/json' },
    body: JSON.stringify({ board: link.board, agent: label }) });
  assert.equal(response.status, 201, 'the real board delegate mints the revocation target');
  return response.json();
}

/** Start a native revocation and recover only the immutable request identity from actual HTTP. */
async function startRevocation(box, revocations, id) {
  const before = box.server.transit.length;
  const done = revocations.start(id);
  const posted = await waitFor(() => box.server.transit.slice(before).find(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals'),
    'the native revocation posts its sealed request to the real relay');
  const context = JSON.parse(posted.request.toString('utf8')).context;
  assert.equal(context.target, id);
  assert.ok(context.id, 'the actual HTTP request has its own approval id');
  return { command: { done }, context };
}

/** Capture approval inbox responses in Chrome while returning every genuine response unchanged. */
async function observeApprovals(chrome) {
  await chrome.stable(`(() => {
    const original = window.fetch.bind(window);
    window.__approvalObservations = [];
    window.__approvalRelayResponses = [];
    window.__approvalLastActionResponse = null;
    window.__approvalObservationStartedAt = performance.now();
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const response = await original(input, init);
      const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
      const path = url.pathname.split('/');
      const apiDevicePath = path[1] === 'api' && path[2] === 'v1' && path[3] === 'devices';
      const list = method === 'GET' && apiDevicePath && path.length === 6 && path[5] === 'approvals';
      const action = apiDevicePath && path.length === 7 && path[4] === 'approvals' && ['authorize', 'complete'].includes(path[6]);
      if (list || action) {
        const matchesDiagnosticRequest = action
          ? path[5] === window.__approvalDiagnosticRequest
          : window.__approvalDiagnosticRequest !== undefined;
        const entry = { elapsedMs: Math.round(performance.now() - window.__approvalObservationStartedAt),
          route: list ? 'approval-list' : 'approval-' + path[6], status: response.status, ok: response.ok,
          errorCode: null, approvalCount: null, containsRequest: null, matchesDiagnosticRequest };
        try {
          const document = await response.clone().json();
          const code = document.error?.code;
          entry.errorCode = typeof code === 'string' && /^[A-Z0-9_-]{1,64}$/u.test(code) ? code : code ? 'OTHER' : null;
          if (list) {
            entry.approvalCount = document.approvals.length;
            entry.containsRequest = document.approvals.some(row => row.context.id === window.__approvalDiagnosticRequest);
            entry.matchesDiagnosticRequest = window.__approvalDiagnosticRequest !== undefined;
            window.__approvalObservations.push({ elapsedMs: entry.elapsedMs, status: response.status,
              count: entry.approvalCount, ids: document.approvals.map(row => row.context.id) });
          }
        } catch { entry.errorCode = 'NON_JSON_RESPONSE'; }
        if (entry.matchesDiagnosticRequest) {
          if (action) window.__approvalLastActionResponse = { ...entry };
          window.__approvalRelayResponses.push(entry);
          window.__approvalRelayResponses = window.__approvalRelayResponses.slice(-12);
        }
      }
      return response;
    };
  })()`);
}

/** Hold the real WebCrypto decrypt result for one authenticated approval, then delegate unchanged. */
async function holdNextApprovalDecrypt(chrome) {
  await chrome.stable(`(() => {
    const subtle = crypto.subtle;
    const original = subtle.decrypt.bind(subtle);
    window.__approvalDecrypt = { armed: true, started: false, release: null };
    Object.defineProperty(subtle, 'decrypt', { configurable: true, value: async function(...args) {
      const gate = window.__approvalDecrypt;
      if (gate?.armed) {
        gate.armed = false; gate.started = true;
        await new Promise(resolve => { gate.release = resolve; });
      }
      return original(...args);
    }});
  })()`);
}

/** Hold one real completed authorize response while allowing the browser to poll other rows. */
async function holdAuthorizeResponse(chrome, requestId) {
  await chrome.stable(`(() => {
    const original = window.fetch.bind(window);
    window.__authorizeGate = { id: ${JSON.stringify(requestId)}, started: false, release: null };
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const gate = window.__authorizeGate;
      if (gate && gate.id && url.pathname.endsWith('/' + gate.id + '/authorize')) {
        gate.started = true;
        await new Promise(resolve => { gate.release = resolve; });
        window.__authorizeGate = null;
      }
      return response;
    };
  })()`);
}

/** Hold genuine inbox responses while a refused completion's still-visible card is inspected. */
async function holdApprovalInboxResponses(chrome) {
  await chrome.stable(`(() => {
    const original = window.fetch;
    let release;
    const released = new Promise(resolve => { release = resolve; });
    const gate = { started: false, released: false,
      /** Restore the exact fetch wrapper and let every held real response finish. */
      finish() { this.released = true; window.fetch = original; release(); delete window.__approvalInboxHold; } };
    window.__approvalInboxHold = gate;
    window.fetch = async (input, init) => {
      const response = await original.call(window, input, init);
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
      if (!gate.released && method === 'GET' && /^\\/api\\/v1\\/devices\\/[^/]+\\/approvals$/u.test(url.pathname)) {
        gate.started = true;
        await released;
      }
      return response;
    };
  })()`);
}

/** Tap the actual phone card and wait for its native command to finish once. */
async function approve(chrome, requestId, command) {
  await assert.doesNotReject(() => chrome.waitFor(`document.querySelector('#phone-approve-${requestId}') !== null`),
    'the delivered approval becomes a visible card');
  await chrome.stable(`(() => {
    window.__approvalDiagnosticRequest = ${JSON.stringify(requestId)};
    window.__approvalRelayResponses = [];
    window.__approvalLastActionResponse = null;
  })()`);
  await chrome.click(`document.querySelector('#phone-approve-${requestId}')`);
  const result = await command.done;
  assert.equal(result.code, 0, 'one real phone tap completes its native approval command');
  await waitForApprovalCardRemoval(chrome, requestId);
  return result;
}

/** Capture a removal failure using the original browser budget unless a diagnostic fixture supplies one. */
async function waitForApprovalCardRemoval(chrome, requestId, timeoutMs) {
  try {
    await chrome.waitFor(`document.querySelector('#phone-approve-${requestId}') === null`, timeoutMs);
  } catch (error) {
    let page;
    try {
      const relaySnapshot = await chrome.stable(`(() => {
        const lastRelayResponses = (window.__approvalRelayResponses ?? []).slice(-8).map(entry => ({ ...entry }));
        const lastActionResponse = window.__approvalLastActionResponse ? { ...window.__approvalLastActionResponse } : null;
        window.__approvalFailureRelayResponses = lastRelayResponses;
        return { observedAt: new Date().toISOString(), entries: lastRelayResponses, lastActionResponse };
      })()`);
      const observation = await chrome.stable(`(() => {
        const card = document.querySelector('.phone-approval[data-request="${requestId}"]');
        const button = card?.querySelector('button');
        return {
          capturedAt: new Date().toISOString(), capturedAfter: 'the existing card-removal wait rejected',
          elapsedMs: Math.round(performance.now() - (window.__approvalObservationStartedAt ?? performance.now())),
          card: { present: Boolean(card), requestMatches: card?.dataset.request === ${JSON.stringify(requestId)},
            buttonText: (button?.textContent ?? '').slice(0, 80) || null, buttonDisabled: button?.disabled ?? null },
          cardRefusal: (card?.querySelector('p')?.textContent ?? '').startsWith('Approval failed: ')
            ? card.querySelector('p').textContent.slice(0, 320) : null,
          panelError: (document.querySelector('#phone-approvals')?.getAttribute('data-error') ?? '').slice(0, 240) || null,
          refusalNotice: (document.querySelector('#relay-notice')?.textContent ?? '').slice(0, 240) || null,
        };
      })()`);
      const targetAction = relaySnapshot.lastActionResponse?.matchesDiagnosticRequest === true
        ? relaySnapshot.lastActionResponse : null;
      const lastRelayResponse = relaySnapshot.entries.at(-1) ?? null;
      page = { ...observation, relayResponsesObservedAt: relaySnapshot.observedAt,
        lastRelayResponses: relaySnapshot.entries,
        targetResponse: targetAction ? `${targetAction.route}:${targetAction.status}:matched` : 'none',
        lastRelayResponse: lastRelayResponse ? `${lastRelayResponse.route}:${lastRelayResponse.status}:matched` : 'none' };
    } catch (captureError) {
      page = { captureError: String(captureError?.message ?? captureError).slice(0, 240) };
    }
    const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,64}$/u.test(error.code) ? error.code : 'none';
    const captureSummary = page.captureError ? 'captureError=true' : `captureError=false; cardPresent=${page.card?.present === true}; requestMatches=${page.card?.requestMatches === true}; targetResponse=${page.targetResponse ?? 'none'}; lastRelayResponse=${page.lastRelayResponse ?? 'none'}`;
    error.message = `${String(error?.message ?? error).slice(0, 500)}; ROOT-CAUSE STATUS: NOT PROVEN; capture follows the original wait failure and contains no response bodies; waitCode=${errorCode}; ${captureSummary}; page=${JSON.stringify(page)}`;
    throw error;
  }
}

test('relay.approval-revoke.an-approval-delivered-while-the-page: an approval delivered while the page is busy still becomes a card [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayDirectFixture(t, { openCellBoard, closeCellBoard });
  const { chrome } = await pairChromePhone(box, t);
  const native = nativeRevocations(box, t);
  await observeApprovals(chrome);

  // Hold the actual wrapped-key HTTP response during reload. A native approval is enqueued while
  // createTransport is still loading the browser key; the response is released without alteration.
  const preload = `(() => {
    const original = window.fetch.bind(window);
    window.__keyLoadGate = { started: false, release: null, polls: [] };
    window.__approvalRelayResponses = [];
    window.__approvalLastActionResponse = null;
    window.__approvalObservationStartedAt = performance.now();
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const response = await original(input, init);
      const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
      const path = url.pathname.split('/');
      const apiDevicePath = path[1] === 'api' && path[2] === 'v1' && path[3] === 'devices';
      const list = method === 'GET' && apiDevicePath && path.length === 6 && path[5] === 'approvals';
      const action = apiDevicePath && path.length === 7 && path[4] === 'approvals' && ['authorize', 'complete'].includes(path[6]);
      if (list || action) {
        const matchesDiagnosticRequest = action
          ? path[5] === window.__approvalDiagnosticRequest
          : window.__approvalDiagnosticRequest !== undefined;
        const entry = { elapsedMs: Math.round(performance.now() - window.__approvalObservationStartedAt),
          route: list ? 'approval-list' : 'approval-' + path[6], status: response.status, ok: response.ok,
          errorCode: null, approvalCount: null, containsRequest: null, matchesDiagnosticRequest };
        try {
          const document = await response.clone().json();
          const code = document.error?.code;
          entry.errorCode = typeof code === 'string' && /^[A-Z0-9_-]{1,64}$/u.test(code) ? code : code ? 'OTHER' : null;
          if (list) {
            entry.approvalCount = document.approvals.length;
            entry.containsRequest = document.approvals.some(row => row.context.id === window.__approvalDiagnosticRequest);
            entry.matchesDiagnosticRequest = window.__approvalDiagnosticRequest !== undefined;
          }
        } catch { entry.errorCode = 'NON_JSON_RESPONSE'; }
        if (entry.matchesDiagnosticRequest) {
          if (action) window.__approvalLastActionResponse = { ...entry };
          window.__approvalRelayResponses.push(entry);
          window.__approvalRelayResponses = window.__approvalRelayResponses.slice(-12);
        }
      }
      if (url.pathname.startsWith('/api/v1/devices/device-') && url.pathname.endsWith('/boards') && window.__keyLoadGate) {
        window.__keyLoadGate.started = true;
        await new Promise(resolve => { window.__keyLoadGate.release = resolve; });
        window.__keyLoadGate = null;
      }
      if (url.pathname.endsWith('/approvals') && (init?.method ?? input?.method ?? 'GET') === 'GET') {
        const document = await response.clone().json();
        window.__approvalObservations ??= [];
        window.__approvalObservations.push({ count: document.approvals.length, ids: document.approvals.map(row => row.context.id) });
      }
      return response;
    };
  })()`;
  const preloadScript = await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: preload });
  await chrome.send('Page.reload');
  await chrome.waitFor('window.__keyLoadGate?.started === true', 20_000, 'the real browser is loading its wrapped board key'); // budget: hang ceiling for the deliberately held key-load stage handshake; no throughput claim.
  const firstToken = await issueToken(box, 'approval-key-load');
  const keyLoad = await startRevocation(box, native, firstToken.id);
  const deviceId = JSON.parse(readFileSync(join(process.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8')).devices[0].deviceId;
  const deliveredDuringKeyLoad = await chrome.stable(`fetch('/api/v1/devices/${deviceId}/approvals', {
    credentials: 'same-origin', cache: 'no-store', headers: { 'x-pullboard-engine': '${ENGINE_VERSION}' }
  }).then(response => response.json()).then(document => ({ status: document.version,
    row: document.approvals.find(value => value.context.id === '${keyLoad.context.id}')?.context.id ?? null }))`);
  assert.equal(deliveredDuringKeyLoad.row, keyLoad.context.id,
    'the actual authenticated inbox response delivers the row while wrapped-key loading is paused');
  await chrome.stable('window.__keyLoadGate.release()');
  await chrome.waitFor(`document.querySelector('#phone-approve-${keyLoad.context.id}') !== null`);
  const keyLoadPolls = await chrome.stable('window.__approvalObservations');
  assert.ok(keyLoadPolls.some(poll => poll.ids.includes(keyLoad.context.id)), 'the real inbox response includes the approval received during key loading');
  await approve(chrome, keyLoad.context.id, keyLoad.command);
  await chrome.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: preloadScript.identifier });

  // Keep the actual same-origin phone key, and exercise the production approval installer directly
  // so a temporarily missing publisher key can be released without the cockpit's separate refresh.
  await chrome.navigate(box.origin + '/relay/browser-devices.js');
  await chrome.stable(`(async () => {
    document.body.innerHTML = '<main></main>';
    const module = await import('/relay/browser-devices.js');
    window.__approvalDocumentAt = async (path, options = {}) => {
      const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store',
        headers: { 'x-pullboard-engine': '${ENGINE_VERSION}', ...options.headers } });
      if (!response.ok) throw new Error('Private approval HTTP refusal');
      return response.json();
    };
    window.__approvalKeys = await module.deviceBoardKeys(window.__approvalDocumentAt);
    window.__publisher = Object.keys(window.__approvalKeys)[0];
    window.__publisherKey = window.__approvalKeys[window.__publisher];
    delete window.__approvalKeys[window.__publisher];
    await module.installPhoneApprovals(window.__approvalDocumentAt, window.__approvalKeys, async () => {});
  })()`);
  await observeApprovals(chrome);
  const missingToken = await issueToken(box, 'approval-missing-key');
  const missingKey = await startRevocation(box, native, missingToken.id);
  await chrome.waitFor(`window.__approvalObservations.some(poll => poll.ids.includes('${missingKey.context.id}'))`);
  assert.equal(await chrome.stable(`document.querySelector('#phone-approve-${missingKey.context.id}') === null`), true,
    'a genuine delivered row cannot render until its actual publisher key is available');
  await chrome.stable('window.__approvalKeys[window.__publisher] = window.__publisherKey');
  await approve(chrome, missingKey.context.id, missingKey.command);

  // Hold the actual approval decrypt, after the genuine inbox response but before card creation.
  await holdNextApprovalDecrypt(chrome);
  const secondToken = await issueToken(box, 'approval-render');
  const render = await startRevocation(box, native, secondToken.id);
  await chrome.waitFor('window.__approvalDecrypt?.started === true', 20_000, 'the real sealed approval is being decrypted before rendering'); // budget: hang ceiling for the deliberately held approval-decrypt stage handshake; no throughput claim.
  assert.equal(await chrome.stable(`document.querySelector('#phone-approve-${render.context.id}') === null`), true,
    'the card is not asserted before actual decryption finishes');
  assert.ok((await chrome.stable('window.__approvalObservations')).some(poll => poll.ids.includes(render.context.id)),
    'the browser received this row before its rendering work completed');
  const revokedDeviceId = await enrollProtocolPhone(box);
  const renderLater = await startRevocation(box, native, revokedDeviceId);
  assert.equal(await chrome.stable(`document.querySelector('#phone-approve-${renderLater.context.id}') === null`), true,
    'the second row arrives while the first genuine decrypt is held');
  await chrome.stable('window.__approvalDecrypt.release()');
  await approve(chrome, render.context.id, render.command);
  await approve(chrome, renderLater.context.id, renderLater.command);

  const deliveredIds = await chrome.stable('window.__approvalObservations.flatMap(poll => poll.ids)');
  for (const context of [missingKey.context, render.context, renderLater.context]) {
    assert.ok(deliveredIds.includes(context.id), 'every actual inbox row observed by Chrome becomes its own approval card');
  }

  // A separate paired phone keeps the actual prior-action control independent of device revocation.
  {
    const box = await relayDirectFixture(t, { openCellBoard, closeCellBoard });
    const { chrome } = await pairChromePhone(box, t);
    const native = nativeRevocations(box, t);
    await observeApprovals(chrome);
    const deviceId = await enrollProtocolPhone(box);
    // While one real approval click waits on its authorize response, publish a different action.
    const thirdToken = await issueToken(box, 'approval-earlier-action');
    const earlier = await startRevocation(box, native, thirdToken.id);
    await chrome.waitFor(`document.querySelector('#phone-approve-${earlier.context.id}') !== null`);
    await holdAuthorizeResponse(chrome, earlier.context.id);
    await chrome.click(`document.querySelector('#phone-approve-${earlier.context.id}')`);
    await chrome.waitFor('window.__authorizeGate?.started === true', 20_000, 'the first real approval is in flight'); // budget: hang ceiling for the deliberately held authorize-response stage handshake; no throughput claim.
    const second = await startRevocation(box, native, deviceId);
    assert.equal(second.context.action, 'revoke-device');
    await chrome.waitFor(`document.querySelector('#phone-approve-${second.context.id}') !== null`);
    assert.ok((await chrome.stable('window.__approvalObservations')).some(poll => poll.ids.includes(second.context.id)),
      'a later approval reaches the page while it handles an earlier one');
    await chrome.stable('window.__authorizeGate.release()');
    const earlierResult = await earlier.command.done;
    assert.equal(earlierResult.code, 0);
    await chrome.waitFor(`document.querySelector('#phone-approve-${earlier.context.id}') === null`);
    await approve(chrome, second.context.id, second.command);
  }
});

test('relay.approval-revoke.a-completed-approval-keeps-its-visible: a completed approval keeps its visible refusal in the retained card [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayDirectFixture(t, { openCellBoard, closeCellBoard });
  const { chrome } = await pairChromePhone(box, t);
  const native = nativeRevocations(box, t);
  await observeApprovals(chrome);
  const token = await issueToken(box, 'approval-completion-response-refused');
  const approval = await startRevocation(box, native, token.id);
  const selector = `.phone-approval[data-request="${approval.context.id}"]`;
  await chrome.waitFor(`document.querySelector('#phone-approve-${approval.context.id}') !== null`);
  await chrome.stable(`(() => {
    window.__approvalDiagnosticRequest = ${JSON.stringify(approval.context.id)};
    window.__approvalRelayResponses = [];
    window.__approvalLastActionResponse = null;
  })()`);

  // The fixture stores the real sealed completion before returning a real HTTP 403 to this phone.
  await holdApprovalInboxResponses(chrome);
  try {
    await chrome.waitFor('window.__approvalInboxHold?.started === true', undefined,
      'a real inbox response is held before the completion changes the card lifetime');
    box.server.refuseNextAcceptedApprovalCompletionResponse();
    await chrome.click(`document.querySelector('#phone-approve-${approval.context.id}')`);
    const nativeResult = await approval.command.done;
    assert.equal(nativeResult.code, 0, 'the native command receives and executes the sealed completion before the phone gets its refusal');
    await chrome.waitFor(`window.__approvalLastActionResponse?.status === 403 && document.querySelector(${JSON.stringify(selector)})?.querySelector('p')?.textContent.startsWith('Approval failed: ')`, 30_000, 'the phone retains the card and renders the actual completion refusal'); // budget: 30s hang ceiling for native completion, one phone poll and refusal render; no speed assertion.
    const observed = await chrome.stable(`(() => ({
      action: window.__approvalLastActionResponse,
      card: (() => { const node = document.querySelector(${JSON.stringify(selector)}); return {
        present: Boolean(node), text: node?.querySelector('p')?.textContent ?? null,
      }; })(),
    }))()`);
    assert.deepEqual({ route: observed.action?.route, status: observed.action?.status,
      matches: observed.action?.matchesDiagnosticRequest, errorCode: observed.action?.errorCode }, {
      route: 'approval-complete', status: 403, matches: true, errorCode: 'REVIEWER_COMPLETE_REFUSED',
    }, 'the authenticated same-origin completion route returns its refusal after storing the sealed reply');
    assert.equal(observed.card.present, true, 'the refused response leaves the real approval card visible');
    assert.equal(observed.card.text,
      'Approval failed: [REVIEWER_COMPLETE_REFUSED] The completion response was refused after sealed delivery.',
      'the retained card displays the exact completion refusal captured on timeout');
    await assert.rejects(waitForApprovalCardRemoval(chrome, approval.context.id, 1_000), // budget: 1s is only a hang ceiling for this already-refused-card observation; the original scenario keeps its 85s window.
      error => {
        assert.match(error.message,
          /"cardRefusal":"Approval failed: \[REVIEWER_COMPLETE_REFUSED\] The completion response was refused after sealed delivery\./u,
          'the original wait-failure capture includes the actual visible per-card refusal');
        assert.match(error.message, /targetResponse=approval-complete:403:matched/u,
          'the same captured failure retains the matched completion 403 witness');
        return true;
    }, 'the retained card keeps its visible refusal after the real completion response');
    const completed = box.server.transit.findLast(record => record.method === 'POST'
      && record.path === '/api/v1/devices/approvals/' + approval.context.id + '/complete');
    assert.ok(completed, 'the real relay received the phone completion POST');
    assert.equal(JSON.parse(completed.response.toString('utf8')).error?.code, 'REVIEWER_COMPLETE_REFUSED',
      'the relay response body records the refusal after its completion side effect');
  } finally {
    await chrome.stable('window.__approvalInboxHold?.finish()');
  }
});

test('relay.approval-revoke.an-approval-the-relay-refuses-fails: an approval the relay refuses fails the Mac command with its request id [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayDirectFixture(t, { openCellBoard, closeCellBoard });
  await pairChromePhone(box, t);
  const native = nativeRevocations(box, t);
  const token = await issueToken(box, 'approval-clock-refusal');
  const before = box.server.transit.length;
  const callsBefore = box.server.calls.length;
  box.server.advance(-31 / 86400);
  let refused;
  try { refused = await native.start(token.id); }
  finally { box.server.advance(0); }

  const post = box.server.transit.slice(before).find(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals');
  assert.ok(post, 'the native revocation attempted to publish its sealed request');
  const context = JSON.parse(post.request.toString('utf8')).context;
  const reply = JSON.parse(post.response.toString('utf8'));
  assert.equal(reply.error?.code, 'PHONE_APPROVAL_CONTEXT', 'the real relay refused the skewed expiry bound');
  assert.equal(refused.code, 1, 'the native command reports the publication refusal');
  assert.equal(refused.error.code, 'PHONE_APPROVAL_CONTEXT', 'the original relay refusal code reaches the Mac');
  assert.match(refused.error.message, new RegExp(context.id), 'the failure identifies the exact request that was refused');
  const refusal = JSON.stringify({ code: refused.error.code, message: refused.error.message });
  assert.match(refusal, /PHONE_APPROVAL_CONTEXT/u);
  assert.match(refusal, /bounded ten-minute sealed approval/u, 'the relay reason survives the native refusal');
  assert.equal(box.server.calls.slice(callsBefore).some(call => call.method === 'GET' && call.path === '/api/v1/devices/approvals/' + context.id), false,
    'the native command reports the failed publish without entering a misleading poll loop');
});
