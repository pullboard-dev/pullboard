/** Real native approvals survive page work and keep refusal identity [H15,H12]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from './relay-client-fixture.js';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';
import { ENGINE_VERSION } from '../src/machine.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');
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
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const response = await original(input, init);
      if (url.pathname.endsWith('/approvals') && (init?.method ?? input?.method ?? 'GET') === 'GET') {
        const document = await response.clone().json();
        window.__approvalObservations.push({ count: document.approvals.length,
          ids: document.approvals.map(row => row.context.id) });
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

/** Tap the actual phone card and wait for its native command to finish once. */
async function approve(chrome, requestId, command) {
  await assert.doesNotReject(() => chrome.waitFor(`document.querySelector('#phone-approve-${requestId}') !== null`),
    'the delivered approval becomes a visible card');
  await chrome.evaluate(`document.querySelector('#phone-approve-${requestId}').click()`);
  const result = await command.done;
  assert.equal(result.code, 0, 'one real phone tap completes its native approval command');
  await chrome.waitFor(`document.querySelector('#phone-approve-${requestId}') === null`);
  return result;
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
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const response = await original(input, init);
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
  await chrome.waitFor('window.__keyLoadGate?.started === true', 20_000, 'the real browser is loading its wrapped board key');
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
  await chrome.waitFor('window.__approvalDecrypt?.started === true', 20_000, 'the real sealed approval is being decrypted before rendering');
  assert.equal(await chrome.evaluate(`document.querySelector('#phone-approve-${render.context.id}') === null`), true,
    'the card is not asserted before actual decryption finishes');
  assert.ok((await chrome.evaluate('window.__approvalObservations')).some(poll => poll.ids.includes(render.context.id)),
    'the browser received this row before its rendering work completed');
  const renderLater = await startRevocation(box, native, deviceId);
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
    const deviceId = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8')).devices[0].deviceId;
    // While one real approval click waits on its authorize response, publish a different action.
    const thirdToken = await issueToken(box, 'approval-earlier-action');
    const earlier = await startRevocation(box, native, thirdToken.id);
    await chrome.waitFor(`document.querySelector('#phone-approve-${earlier.context.id}') !== null`);
    await holdAuthorizeResponse(chrome, earlier.context.id);
    await chrome.evaluate(`document.querySelector('#phone-approve-${earlier.context.id}').click()`);
    await chrome.waitFor('window.__authorizeGate?.started === true', 20_000, 'the first real approval is in flight');
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
