// pullboard: browser
/** @pullboard-test-gui */
/** Real native approvals survive page work and keep refusal identity [H15,H12]. */
import assert from 'node:assert/strict';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  resolve,
  join,
} from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from '../../../test/relay-client-fixture.js';
import { enrollProtocolPhone } from '../../../test/relay-device-enrollment-fixture.js';
import {
  findChromeExecutable,
  startChrome,
} from '../../../test/relay-browser-fixture.js';
import { ENGINE_VERSION } from '../src/shell/machine.js';

const CLI = resolve(import.meta.dirname, '../../../bin/pullboard.js');
const APPROVAL_TIMEOUT_MS = 90_000;

/** Poll an actual fixture state transition without retrying the operation under test. */
async function waitFor(read, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  assert.fail(message);
}

/** Run the production CLI in the isolated project, preserving JSON for precise refusal checks. */
function cliCommand(root, env, args, timeoutMs = APPROVAL_TIMEOUT_MS, { json = true } = {}) {
  const child = spawn(process.execPath, [CLI, ...args, ...(json ? ['--json'] : [])], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error('A private native approval command exceeded its finite fixture bound.'));
      try { resolveResult({ code, document: json ? JSON.parse(stdout) : null, stdout, stderr }); }
      catch { reject(new Error('The private approval command did not return JSON.')); }
    });
  });
  return { child, done };
}

/** Start foreground machine setup and pair one real Chrome device through the real relay. */
async function pairPhone(box, t) {
  const setup = cliCommand(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin], 120_000);
  let chrome;
  const native = [setup];
  t.after(async () => {
    for (const command of native) if (command.child.exitCode === null) command.child.kill('SIGTERM');
    for (const command of native) await command.done.catch(() => {});
    await chrome?.close();
  });
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const pending = await waitFor(() => {
    if (!existsSync(machineFile)) return null;
    return JSON.parse(readFileSync(machineFile, 'utf8')).pending;
  }, 'foreground setup publishes a real one-use phone enrollment');
  chrome = await startChrome();
  const session = await box.phoneSession();
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: session.token, url: box.origin,
    httpOnly: true, sameSite: 'Lax' })).success, true);
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  const paired = await setup.done;
  assert.equal(paired.code, 0, 'the real phone enrollment completes native setup');
  await chrome.waitFor("document.querySelector('#phone-approvals') !== null");
  return { chrome, native, machineFile };
}

/** Issue a real board-scoped token through the fixture's persistent relay-auth database. */
async function issueToken(box, label) {
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const response = await fetch(box.origin + '/auth/tokens', { method: 'POST',
    headers: { authorization: 'Bearer ' + link.token, 'content-type': 'application/json' },
    body: JSON.stringify({ board: link.board, agent: label }) });
  assert.equal(response.status, 201, 'the real board delegate mints the revocation target');
  return response.json();
}

/** Start a native revocation and recover only the immutable request identity from actual HTTP. */
async function startRevocation(box, native, id) {
  const before = box.transit.length;
  const command = cliCommand(box.root, box.env, ['relay', 'revoke', id]);
  native.push(command);
  const posted = await waitFor(() => box.transit.slice(before).find(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals'),
    'the production CLI posts its sealed request to the real relay');
  const context = JSON.parse(posted.request.toString('utf8')).context;
  assert.equal(context.target, id);
  assert.ok(context.id, 'the actual HTTP request has its own approval id');
  return { command, context };
}

/** Capture approval inbox responses in Chrome while returning every genuine response unchanged. */
async function observeApprovals(chrome) {
  await chrome.evaluate(`(() => {
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
  await chrome.evaluate(`(() => {
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
  await chrome.evaluate(`(() => {
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
  await chrome.evaluate(`(() => {
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
  await chrome.evaluate(`(() => {
    window.__approvalDiagnosticRequest = ${JSON.stringify(requestId)};
    window.__approvalRelayResponses = [];
    window.__approvalLastActionResponse = null;
  })()`);
  await chrome.evaluate(`document.querySelector('#phone-approve-${requestId}').click()`);
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
      const relaySnapshot = await chrome.evaluate(`(() => {
        const lastRelayResponses = (window.__approvalRelayResponses ?? []).slice(-8).map(entry => ({ ...entry }));
        const lastActionResponse = window.__approvalLastActionResponse ? { ...window.__approvalLastActionResponse } : null;
        window.__approvalFailureRelayResponses = lastRelayResponses;
        return { observedAt: new Date().toISOString(), entries: lastRelayResponses, lastActionResponse };
      })()`);
      const observation = await chrome.evaluate(`(() => {
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

test('an approval delivered while the page is busy still becomes a card [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, native } = await pairPhone(box, t);
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
  const deviceId = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8')).devices[0].deviceId;
  const deliveredDuringKeyLoad = await chrome.evaluate(`fetch('/api/v1/devices/${deviceId}/approvals', {
    credentials: 'same-origin', cache: 'no-store', headers: { 'x-pullboard-engine': '${ENGINE_VERSION}' }
  }).then(response => response.json()).then(document => ({ status: document.version,
    row: document.approvals.find(value => value.context.id === '${keyLoad.context.id}')?.context.id ?? null }))`);
  assert.equal(deliveredDuringKeyLoad.row, keyLoad.context.id,
    'the actual authenticated inbox response delivers the row while wrapped-key loading is paused');
  await chrome.evaluate('window.__keyLoadGate.release()');
  await chrome.waitFor(`document.querySelector('#phone-approve-${keyLoad.context.id}') !== null`);
  const keyLoadPolls = await chrome.evaluate('window.__approvalObservations');
  assert.ok(keyLoadPolls.some(poll => poll.ids.includes(keyLoad.context.id)), 'the real inbox response includes the approval received during key loading');
  await approve(chrome, keyLoad.context.id, keyLoad.command);
  await chrome.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: preloadScript.identifier });

  // Keep the actual same-origin phone key, and exercise the production approval installer directly
  // so a temporarily missing publisher key can be released without the cockpit's separate refresh.
  await chrome.navigate(box.origin + '/relay/browser-devices.js');
  await chrome.evaluate(`(async () => {
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
  assert.equal(await chrome.evaluate(`document.querySelector('#phone-approve-${missingKey.context.id}') === null`), true,
    'a genuine delivered row cannot render until its actual publisher key is available');
  await chrome.evaluate('window.__approvalKeys[window.__publisher] = window.__publisherKey');
  await approve(chrome, missingKey.context.id, missingKey.command);

  // Hold the actual approval decrypt, after the genuine inbox response but before card creation.
  await holdNextApprovalDecrypt(chrome);
  const secondToken = await issueToken(box, 'approval-render');
  const render = await startRevocation(box, native, secondToken.id);
  await chrome.waitFor('window.__approvalDecrypt?.started === true', 20_000, 'the real sealed approval is being decrypted before rendering'); // budget: hang ceiling for the deliberately held approval-decrypt stage handshake; no throughput claim.
  assert.equal(await chrome.evaluate(`document.querySelector('#phone-approve-${render.context.id}') === null`), true,
    'the card is not asserted before actual decryption finishes');
  assert.ok((await chrome.evaluate('window.__approvalObservations')).some(poll => poll.ids.includes(render.context.id)),
    'the browser received this row before its rendering work completed');
  const revokedDeviceId = await enrollProtocolPhone(box);
  const renderLater = await startRevocation(box, native, revokedDeviceId);
  assert.equal(await chrome.evaluate(`document.querySelector('#phone-approve-${renderLater.context.id}') === null`), true,
    'the second row arrives while the first genuine decrypt is held');
  await chrome.evaluate('window.__approvalDecrypt.release()');
  await approve(chrome, render.context.id, render.command);
  await approve(chrome, renderLater.context.id, renderLater.command);

  const deliveredIds = await chrome.evaluate('window.__approvalObservations.flatMap(poll => poll.ids)');
  for (const context of [missingKey.context, render.context, renderLater.context]) {
    assert.ok(deliveredIds.includes(context.id), 'every actual inbox row observed by Chrome becomes its own approval card');
  }

  // A separate paired phone keeps the actual prior-action control independent of device revocation.
  {
    const box = await relayClientFixture(t);
    const { chrome, native } = await pairPhone(box, t);
    await observeApprovals(chrome);
    const deviceId = await enrollProtocolPhone(box);
    // While one real approval click waits on its authorize response, publish a different action.
    const thirdToken = await issueToken(box, 'approval-earlier-action');
    const earlier = await startRevocation(box, native, thirdToken.id);
    await chrome.waitFor(`document.querySelector('#phone-approve-${earlier.context.id}') !== null`);
    await holdAuthorizeResponse(chrome, earlier.context.id);
    await chrome.evaluate(`document.querySelector('#phone-approve-${earlier.context.id}').click()`);
    await chrome.waitFor('window.__authorizeGate?.started === true', 20_000, 'the first real approval is in flight'); // budget: hang ceiling for the deliberately held authorize-response stage handshake; no throughput claim.
    const second = await startRevocation(box, native, deviceId);
    assert.equal(second.context.action, 'revoke-device');
    await chrome.waitFor(`document.querySelector('#phone-approve-${second.context.id}') !== null`);
    assert.ok((await chrome.evaluate('window.__approvalObservations')).some(poll => poll.ids.includes(second.context.id)),
      'a later approval reaches the page while it handles an earlier one');
    await chrome.evaluate('window.__authorizeGate.release()');
    const earlierResult = await earlier.command.done;
    assert.equal(earlierResult.code, 0);
    await chrome.waitFor(`document.querySelector('#phone-approve-${earlier.context.id}') === null`);
    await approve(chrome, second.context.id, second.command);
  }
});

test('a completed approval keeps its visible refusal in the retained card [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, native } = await pairPhone(box, t);
  await observeApprovals(chrome);
  const token = await issueToken(box, 'approval-completion-response-refused');
  const approval = await startRevocation(box, native, token.id);
  const selector = `.phone-approval[data-request="${approval.context.id}"]`;
  await chrome.waitFor(`document.querySelector('#phone-approve-${approval.context.id}') !== null`);
  await chrome.evaluate(`(() => {
    window.__approvalDiagnosticRequest = ${JSON.stringify(approval.context.id)};
    window.__approvalRelayResponses = [];
    window.__approvalLastActionResponse = null;
  })()`);

  // The fixture stores the real sealed completion before returning a real HTTP 403 to this phone.
  await holdApprovalInboxResponses(chrome);
  try {
    await chrome.waitFor('window.__approvalInboxHold?.started === true', undefined,
      'a real inbox response is held before the completion changes the card lifetime');
    box.refuseNextAcceptedApprovalCompletionResponse();
    await chrome.evaluate(`document.querySelector('#phone-approve-${approval.context.id}').click()`);
    const nativeResult = await approval.command.done;
    assert.equal(nativeResult.code, 0, 'the native command receives and executes the sealed completion before the phone gets its refusal');
    await chrome.waitFor(`window.__approvalLastActionResponse?.status === 403 && document.querySelector(${JSON.stringify(selector)})?.querySelector('p')?.textContent.startsWith('Approval failed: ')`, 30_000, 'the phone retains the card and renders the actual completion refusal'); // budget: 30s hang ceiling for native completion, one phone poll and refusal render; no speed assertion.
    const observed = await chrome.evaluate(`(() => ({
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
    const completed = box.transit.findLast(record => record.method === 'POST'
      && record.path === '/api/v1/devices/approvals/' + approval.context.id + '/complete');
    assert.ok(completed, 'the real relay received the phone completion POST');
    assert.equal(JSON.parse(completed.response.toString('utf8')).error?.code, 'REVIEWER_COMPLETE_REFUSED',
      'the relay response body records the refusal after its completion side effect');
  } finally {
    await chrome.evaluate('window.__approvalInboxHold?.finish()');
  }
});

test('an approval the relay refuses fails the Mac command with its request id [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  await pairPhone(box, t);
  const token = await issueToken(box, 'approval-clock-refusal');
  const before = box.transit.length;
  const callsBefore = box.calls.length;
  box.advance(-31 / 86400);
  let refused;
  try { refused = await box.cli('relay', 'revoke', token.id); }
  finally { box.advance(0); }

  const post = box.transit.slice(before).find(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals');
  assert.ok(post, 'the real native CLI attempted to publish its sealed request');
  const context = JSON.parse(post.request.toString('utf8')).context;
  const reply = JSON.parse(post.response.toString('utf8'));
  assert.equal(reply.error?.code, 'PHONE_APPROVAL_CONTEXT', 'the real relay refused the skewed expiry bound');
  assert.equal(refused.code, 1, 'the native command reports the publication refusal');
  assert.equal(refused.document.error.code, 'PHONE_APPROVAL_CONTEXT', 'the original relay refusal code reaches the Mac');
  assert.match(refused.document.error.message, new RegExp(context.id), 'the failure identifies the exact request that was refused');
  assert.match(JSON.stringify(refused.document), /PHONE_APPROVAL_CONTEXT/u);
  assert.match(JSON.stringify(refused.document), /bounded ten-minute sealed approval/u, 'the relay reason survives the CLI refusal');
  assert.equal(box.calls.slice(callsBefore).some(call => call.method === 'GET' && call.path === '/api/v1/devices/approvals/' + context.id), false,
    'the native command reports the failed publish without entering a misleading poll loop');
});


/** Create a real independent Git project before invoking its public registration command. */
function unregisteredProject(box, name) {
  const root = join(dirname(box.root), name);
  mkdirSync(root);
  for (const args of [['init', '-q', '-b', 'main'],
    ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git']]) {
    assert.equal(spawnSync('git', args, { cwd: root, env: box.env }).status, 0);
  }
  return root;
}

/** Match a real publication refusal to its native partial failure and preserved local outcome. */
function assertRemoteFailure(box, before, result, action, completed) {
  const post = box.transit.slice(before).find(record => record.method === 'POST'
    && record.path === '/api/v1/devices/approvals');
  assert.ok(post, 'the operation attempted its real remote approval');
  const context = JSON.parse(post.request.toString('utf8')).context;
  const response = JSON.parse(post.response.toString('utf8'));
  assert.equal(context.action, action);
  assert.equal(response.error.code, 'PHONE_APPROVAL_CONTEXT', 'the actual relay refused the proposal');
  assert.equal(result.code, 1, 'a remote publication refusal makes the native command fail');
  if (result.document) {
    assert.deepEqual(result.document.remote, { code: 'PHONE_APPROVAL_CONTEXT',
      reason: 'the relay ' + box.origin + ': ' + response.error.message, requestId: context.id }, 'JSON preserves the original remote refusal separately');
    assert.ok(Array.isArray(result.document.diagnostics), 'the partial failure carries its named diagnostic');
  }
  const lines = result.document?.diagnostics ?? result.stderr.split('\n');
  const refusals = lines.filter(line => line.includes('Remote approval request'));
  assert.equal(refusals.length, 1, 'exactly one line names the partial failure');
  assert.ok(refusals[0].includes(context.id), 'the refusal identifies the exact request');
  assert.ok(refusals[0].includes(response.error.message), 'the refusal retains the relay reason');
  assert.ok(refusals[0].includes(completed), 'the same line names the completed local action');
  assert.match(refusals[0], /\[PHONE_APPROVAL_CONTEXT\]/u);
  assert.match(refusals[0], /explicitly/u, 'the refusal gives an explicit recovery step');
  assert.equal(box.transit.slice(before).some(record => record.method === 'GET'
    && record.path === '/api/v1/devices/approvals/' + context.id), false, 'refused publication never waits for an approval');
}

test('local unlink and registration fail on a remote refusal while retaining local work [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  for (const json of [true, false]) await t.test(json ? 'JSON partial failures' : 'text partial failures', async t => {
    const box = await relayClientFixture(t);
    const { native, machineFile } = await pairPhone(box, t);
    const project = unregisteredProject(box, 'remote-refused-registration');
    box.advance(-31 / 86400);
    const registerBefore = box.transit.length;
    const registration = cliCommand(project, box.env, ['init'], APPROVAL_TIMEOUT_MS, { json });
    native.push(registration);
    const registered = await registration.done;
    const offBefore = box.transit.length;
    const unlink = cliCommand(box.root, box.env, ['relay', 'off'], APPROVAL_TIMEOUT_MS, { json });
    native.push(unlink);
    const off = await unlink.done;
    assert.deepEqual([registered.code, off.code], [1, 1], 'both real native publication-refusal paths fail immediately');
    assertRemoteFailure(box, registerBefore, registered, 'link', 'Local registration is complete');
    assertRemoteFailure(box, offBefore, off, 'delete-board', 'Local link removed');
    assert.equal(existsSync(join(project, '.git/pullboard/board.sqlite')), true, 'registration persists the local board');
    assert.equal(existsSync(join(project, '.git/pullboard/relay.json')), false, 'refused linking does not invent a linked board');
    if (json) assert.equal(off.document.linked, false);
    assert.equal(existsSync(box.linkFile), false, 'local unlink is durable despite the remote publication refusal');
    assert.ok(JSON.parse(readFileSync(machineFile, 'utf8')).excluded.includes(box.root), 'the local opt-out remains durable');
  });
});

test('expired and unreachable approvals fail with their exact request id [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { native } = await pairPhone(box, t);
  const token = await issueToken(box, 'approval-expired');
  const expiry = await startRevocation(box, native, token.id);
  box.advance(1);
  const expired = await expiry.command.done;
  box.advance(0);
  assert.equal(expired.code, 1);
  assert.equal(expired.document.error.code, 'PHONE_APPROVAL_EXPIRED');
  assert.ok(expired.document.error.message.includes(expiry.context.id), 'expiry retains the original approval identity');
  const unreachable = await startRevocation(box, native, token.id);
  await box.stopRelay();
  const offline = await unreachable.command.done;
  assert.equal(offline.code, 1);
  assert.equal(offline.document.error.code, 'RELAY_UNAVAILABLE');
  assert.ok(offline.document.error.message.includes(unreachable.context.id), 'unreachable polling retains the approval identity');
});

test('elapsed fixture wall time never manufactures an approval expiry refusal [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, native } = await pairPhone(box, t);
  const token = await issueToken(box, 'approval-elapsed-clock');
  // The old frozen relay clock refuses a real native expiry after thirty seconds of elapsed work.
  await new Promise(resolveWait => setTimeout(resolveWait, 31_000));
  const request = await startRevocation(box, native, token.id);
  const posted = box.transit.find(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals'
    && JSON.parse(record.request.toString('utf8')).context.id === request.context.id);
  assert.equal(JSON.parse(posted.response.toString('utf8')).approval?.context.id, request.context.id,
    'the live fixture clock accepts the actual native ten-minute expiry after elapsed work');
  await approve(chrome, request.context.id, request.command);
});

/** Register one more committed project; its real init publishes a sealed link card to the phone. */
async function registerProject(box, name) {
  const root = join(dirname(box.root), name);
  mkdirSync(root);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', `git@github.com:fixture/${name}.git`]]) {
    assert.equal(spawnSync('git', args, { cwd: root, env: box.env }).status, 0);
  }
  const initialized = await cliCommand(root, box.env, ['init']).done;
  assert.equal(initialized.code, 0, 'the new project registers through the actual init command');
  return root;
}

let approvedLinkRun;

/**
 * Walkthrough-090 issue 15 once, shared by the two tests below: a paired phone, a new board
 * "notes" whose link card waits on it, relay on --all running, one tap. The snapshot upload is
 * held until the phone has rendered its notice, so the phone is observed before its key arrives.
 */
function approvedLinkScenario(t) {
  approvedLinkRun ??= (async () => {
    const box = await relayClientFixture(t);
    const { chrome, native, machineFile } = await pairPhone(box, t);
    box.providerState.repositories.push('notes');
    const notes = await registerProject(box, 'notes');
    const notesTitle = 'an item only on the newly approved notes board';
    const note = cliCommand(notes, box.env, ['add', box.lane, notesTitle]);
    native.push(note);
    const added = await note.done;
    assert.equal(added.code, 0, `the approved board has its own visible item: ${added.stderr}`);
    const proposal = JSON.parse(readFileSync(machineFile, 'utf8')).approvals.find(entry => entry.root === notes);
    assert.ok(proposal?.published, 'init publishes one sealed link card for notes');
    const board = proposal.context.board;
    const button = '#phone-approve-' + proposal.context.id;
    await chrome.waitFor(`document.querySelector(${JSON.stringify(button)}) !== null`);

    const run = cliCommand(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin], 120_000, { json: false });
    native.push(run);
    let live = '';
    run.child.stdout.on('data', chunk => { live += chunk; });
    await waitFor(() => live.includes('waiting for phone approval: notes') || run.child.exitCode !== null,
      'relay on --all reaches its wait for the phone or exits');
    const waited = live.includes('waiting for phone approval: notes');
    if (!waited) {
      const early = await run.done;
      return { waited, stdout: early.stdout, stderr: early.stderr, code: early.code };
    }

    await chrome.evaluate(`(() => {
      const notice = document.querySelector('#relay-notice');
      window.__noticeLog = [notice?.textContent ?? ''];
      new MutationObserver(() => window.__noticeLog.push(notice.textContent))
        .observe(notice, { childList: true, subtree: true, characterData: true });
    })()`);
    let held = false;
    let release;
    const released = new Promise(resolveRelease => { release = resolveRelease; });
    box.beforeNextSnapshot(async () => { held = true; await released; });
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await chrome.evaluate(`document.querySelector('[data-tab="shouts"]').click()`);
    await chrome.waitFor(`view.tab === "shouts" && document.querySelector('[data-pane="items"]').hidden`);
    const documentOrigin = await chrome.evaluate('performance.timeOrigin');
    const authorizeBefore = box.calls.filter(call => call.path.endsWith('/authorize')).length;
    await chrome.evaluate(`document.querySelector(${JSON.stringify(button)}).click()`);
    await waitFor(() => held, 'the computer starts linking notes in the same run once the phone approves');
    let noticeBeforeKey = null;
    try {
      await chrome.waitFor(`(document.querySelector('#relay-notice')?.textContent ?? '').includes(${JSON.stringify(board.slice(0, 8))})
        || (document.querySelector('#relay-notice')?.textContent ?? '').includes('pair this browser')`);
      noticeBeforeKey = await chrome.evaluate(`document.querySelector('#relay-notice').textContent`);
    } finally { release(); }
    const finished = await run.done;
    const linkedAtExit = existsSync(join(notes, '.git/pullboard/relay.json'));
    let opened = true;
    try {
      await chrome.waitFor(`document.querySelectorAll('#proj-list .proj.repo').length === 2
        && Object.hasOwn(JSON.parse(localStorage.getItem('pullboard.relay.keys.v1') ?? '{}'), ${JSON.stringify(board)})`);
    } catch { opened = false; }
    try { /* budget: hang ceiling for the bounded navigation transition the mobile counter observes; no approval retry. */ await chrome.waitFor(`data?.root === ${JSON.stringify(board)} && document.querySelector('#proj-name')?.textContent === 'notes'
      && document.body.innerText.includes(${JSON.stringify(notesTitle)})`, 6_000); } catch { /* The assertion below names a missed selection directly. */ }
    const displayed = await chrome.evaluate(`({ root: data?.root, name: document.querySelector('#proj-name')?.textContent,
      text: document.body.innerText })`);
    const visibleItems = [];
    for (const width of [390, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
      visibleItems.push(await chrome.evaluate(`(() => {
        const pane = document.querySelector('[data-pane="items"]');
        const row = [...document.querySelectorAll('#chain [data-item]')].find(node => node.textContent.includes(${JSON.stringify(notesTitle)}));
        const rect = row?.getBoundingClientRect();
        return { width: innerWidth, tab: view.tab, visible: !pane.hidden && Boolean(rect && row.getClientRects().length && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0) };
      })()`));
    }
    const sameDocument = await chrome.evaluate('performance.timeOrigin') === documentOrigin;
    const rawKey = readFileSync(join(box.env.PULLBOARD_HOME, 'relay-keys', board + '.key'), 'utf8').trim();
    return {
      waited, code: finished.code, stdout: finished.stdout, stderr: finished.stderr, linkedAtExit, opened, noticeBeforeKey,
      noticeLog: await chrome.evaluate('window.__noticeLog'), rawKey, targetBoard: board, notesTitle, displayed, visibleItems, sameDocument,
      taps: box.calls.filter(call => call.path.endsWith('/authorize')).length - authorizeBefore,
    };
  })();
  return approvedLinkRun;
}

test('an approved link opens on the phone without another command [H17,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const run = await approvedLinkScenario(t);
  assert.equal(run.waited, true, `relay on --all waits for the phone's link card: ${run.stdout}`);
  assert.equal(run.taps, 1, 'one phone tap authorizes the link');
  assert.equal(run.code, 0, `the waiting run finishes cleanly: ${run.stderr}`);
  assert.equal(run.linkedAtExit, true, 'the same run links notes; no later command is needed');
  assert.equal(run.opened, true, 'the phone unwraps the notes key and lists the board with no other command');
  assert.equal(run.displayed.root, run.targetBoard, 'the phone selects the newly approved board, rather than only listing it');
  assert.equal(run.displayed.name, 'notes', 'the visible project heading names the approved notes board');
  assert.ok(run.displayed.text.includes(run.notesTitle), "the approved board's own item is visible");
  assert.equal(run.sameDocument, true, 'approval keeps the same browser document');
  for (const result of run.visibleItems) {
    assert.equal(result.tab, 'items', `${result.width}px approval opens Items after Shouts`);
    assert.equal(result.visible, true, `${result.width}px approved item is visible on screen`);
  }
  assert.equal(run.displayed.text.includes('private cleanup fixture item'), false, "the previously open board's item is not left on screen");
  assert.match(run.noticeBeforeKey, /approved; waiting for the computer to send this phone its key\./u,
    'before the key arrives the phone says it is on the way');
  assert.equal(run.noticeLog.some(text => text.includes('pair this browser')), false,
    `the phone that approved is never told to pair again: ${JSON.stringify(run.noticeLog)}`);
});

test('the computer prints linked with the board name [H17,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const run = await approvedLinkScenario(t);
  const lines = run.stdout.split('\n');
  const waiting = lines.findIndex(line => line.startsWith('waiting for phone approval: notes; '));
  assert.ok(waiting >= 0, `the run says which board waits for the phone: ${run.stdout}`);
  assert.equal(lines.filter(line => line === 'linked: notes').length, 1, `the run prints linked: notes once: ${run.stdout}`);
  assert.ok(lines.indexOf('linked: notes') > waiting, 'linked: notes follows the phone tap in the same run');
  assert.equal(run.stdout.includes(run.rawKey) || run.stderr.includes(run.rawKey), false, 'the board key is never printed');
});
