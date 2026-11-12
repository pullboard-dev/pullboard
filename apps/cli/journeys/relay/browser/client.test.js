// pullboard: browser
/** @pullboard-test-input apps/relay/src/io/browser/client.js */
/** @pullboard-test-gui */
/** The relay browser client's sealed snapshot decode, in Chrome and in WebKit [H5,H16]. */
import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
} from '../../../../lib/index.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import {
  tmpdir,
  userInfo,
} from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  findChromeExecutable,
  startChrome,
} from '../../../tests/fixtures/relay/browser.js';
import {
  press,
  stableChrome,
} from '../../../tests/fixtures/cockpit/stable.js';

/** The hosted page's real secure origin, answered from memory: no network is used. */
const ORIGIN = 'https://app.pullboard.dev/';
import { closeBoard } from '../../../../../packages/store/index.js';
import {
  prepareEngineMove,
  applyRelayMove,
} from '../../../../../packages/state/index.js';
import { relaySnapshot } from '../../../../../packages/pages/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import {
  decodeBoardKey,
  seal,
} from '../../../../../packages/kernel/index.js';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;


const CLIENT = new URL('../../../../relay/src/io/browser/client.js', import.meta.url);

/** Two real sealed-snapshot payloads, gzipped as src/relay.js does: a tiny document and a board of 3000 items. */
function snapshotInputs() {
  const items = Array.from({ length: 3000 }, (_, index) => ({ id: index + 1, title: `fixture item ${index + 1}`, status: 'open', lane: 'core', criterion: 'x'.repeat(80) }));
  const documents = {
    small: { hello: 'world', n: [1, 2, 3] },
    board: { version: 1, tables: { item: items } },
  };
  return Object.entries(documents).map(([name, document]) => ({
    name, base64: gzipSync(Buffer.from(JSON.stringify(document))).toString('base64'), length: JSON.stringify(document).length,
  }));
}

/** The snapshotDocument function exactly as apps/relay/src/io/deploy/browser-client.js writes it, cut from the module source. */
function snapshotDocumentSource() {
  const source = readFileSync(CLIENT, 'utf8');
  const start = source.indexOf('async function snapshotDocument(');
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start > 0 && end > start, 'apps/relay/src/io/deploy/browser-client.js still defines snapshotDocument');
  return source.slice(start, end);
}

/** The same function with the decode the client had before #976, which piped a Blob stream: the control WebKit refused. */
function blobStreamSource() {
  return snapshotDocumentSource().replace('new Response(plain).body.pipeThrough', 'new Blob([plain]).stream().pipeThrough');
}

/**
 * Page script that runs one snapshotDocument source on every input and leaves window.result as JSON text naming,
 * per input, the decoded length or the refusal.
 */
function pageScript(decodeSource, inputs, { blobStreamFails = false } = {}) {
  return `class Refused extends Error { constructor(code, message) { super('[' + code + '] ' + message); } }
const withBrowserDeadline = work => work();
${blobStreamFails ? `Blob.prototype.stream = function stream() {
  return new ReadableStream({ start(controller) { controller.error(new TypeError('Failed to Decode Data')); } });
};` : ''}
${decodeSource}
window.result = null;
(async () => {
  const out = {};
  for (const [name, base64] of ${JSON.stringify(inputs.map(input => [input.name, input.base64]))}) {
    const plain = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    try { out[name] = 'decoded ' + JSON.stringify(await snapshotDocument(plain)).length; } catch (error) { out[name] = 'REFUSED ' + error.message; }
  }
  window.result = JSON.stringify(out);
})();`;
}

/** The newest Playwright WebKit build this account has cached, or null on a machine without one. */
function findWebkit() {
  if (process.env.PULLBOARD_WEBKIT) return existsSync(process.env.PULLBOARD_WEBKIT) ? process.env.PULLBOARD_WEBKIT : null;
  if (process.platform !== 'darwin') return null;
  const cache = join(userInfo().homedir, 'Library', 'Caches', 'ms-playwright');
  let builds = [];
  try { builds = readdirSync(cache).filter(name => /^webkit-\d+$/u.test(name)); } catch { return null; }
  builds.sort((left, right) => Number(right.slice(7)) - Number(left.slice(7)));
  for (const build of builds) {
    const executable = join(cache, build, 'Playwright.app', 'Contents', 'MacOS', 'Playwright');
    if (existsSync(executable)) return executable;
  }
  return null;
}

/**
 * Load an HTML page at a real https origin, answering its one request from memory, in WebKit and return the JSON the page leaves in window.result. It drives
 * Playwright's WebKit build over its inspector pipe (JSON separated by NUL on descriptors 3 and 4), with no package.
 * WebKit refused the old decode only on a loaded page at a secure origin, never on about:blank or plain http.
 */
async function runPageInWebkit(executable, html) {
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-webkit-'));
  const frameworks = dirname(dirname(dirname(dirname(executable))));
  const child = spawn(executable, ['--inspector-pipe', '--headless', '--no-startup-window', `--user-data-dir=${profile}`], {
    detached: true, env: { ...process.env, HOME: userInfo().homedir, DYLD_FRAMEWORK_PATH: frameworks, DYLD_LIBRARY_PATH: frameworks },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolveExit => child.once('close', resolveExit));
  const pending = new Map();
  let target = null;
  let pageProxyId = null;
  let nextId = 0;
  let buffer = '';
  /** Send one browser-level command and wait for its answer, with a hang ceiling. */
  const send = (method, params = {}, proxy) => new Promise((resolveSend, rejectSend) => {
    const id = ++nextId;
    const timer = setTimeout(() => rejectSend(new Error(`WebKit ${method} gave no answer`)), 20_000); // budget: hang ceiling for one WebKit command.
    pending.set(id, message => { clearTimeout(timer); message.error ? rejectSend(new Error(`WebKit ${method}: ${message.error.message}`)) : resolveSend(message.result ?? {}); });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(proxy ? { pageProxyId: proxy } : {}) }) + '\0');
  });
  const innerPending = new Map();
  let innerId = 0;
  /** Send one command to a page target and wait for its answer. */
  const toTarget = (targetId, proxy, method, params = {}) => new Promise((resolveTarget, rejectTarget) => {
    const id = ++innerId;
    const timer = setTimeout(() => rejectTarget(new Error(`WebKit page ${method} gave no answer`)), 20_000); // budget: hang ceiling for one WebKit page command.
    innerPending.set(id, inner => { clearTimeout(timer); inner.error ? rejectTarget(new Error(`WebKit page ${method}: ${inner.error.message}`)) : resolveTarget(inner.result); });
    send('Target.sendMessageToTarget', { targetId, message: JSON.stringify({ id, method, params }) }, proxy).catch(rejectTarget);
  });
  /** Answer every request of a target from memory with the page, before the target runs. */
  const intercept = async (targetId, proxy) => {
    await toTarget(targetId, proxy, 'Network.enable');
    await toTarget(targetId, proxy, 'Network.setInterceptionEnabled', { enabled: true });
    await toTarget(targetId, proxy, 'Network.addInterception', { url: '', stage: 'request' });
  };
  /** Follow the page's targets: intercept and resume each, and keep the one that committed. */
  const onEvent = message => {
    if (message.method === 'Target.targetCreated' && message.params.targetInfo.type === 'page') {
      const info = message.params.targetInfo;
      const proxy = message.pageProxyId;
      pageProxyId ??= proxy;
      void (async () => {
        try { await intercept(info.targetId, proxy); } catch { /* A target that closed needs no interception. */ }
        if (!info.isProvisional) target = info.targetId;
        if (info.isPaused) await send('Target.resume', { targetId: info.targetId }, proxy).catch(() => {});
      })();
    } else if (message.method === 'Target.didCommitProvisionalTarget') target = message.params.newTargetId;
    else if (message.method === 'Target.dispatchMessageFromTarget') {
      const inner = JSON.parse(message.params.message);
      if (inner.id !== undefined && innerPending.has(inner.id)) { innerPending.get(inner.id)(inner); innerPending.delete(inner.id); }
      else if (inner.method === 'Network.requestIntercepted') {
        const { requestId, request } = inner.params;
        const ours = request.url === ORIGIN;
        void toTarget(message.params.targetId, message.pageProxyId, ours ? 'Network.interceptRequestWithResponse' : 'Network.interceptRequestWithError',
          ours ? { requestId, content: Buffer.from(html).toString('base64'), base64Encoded: true, mimeType: 'text/html', status: 200, statusText: 'OK', headers: { 'content-type': 'text/html' } }
            : { requestId, errorType: 'General' }).catch(() => {});
      }
    }
  };
  child.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } else onEvent(message);
    }
  });
  /** Evaluate an expression in the page's current target and return its by-value result. */
  const evaluate = async expression => {
    const result = await toTarget(target, pageProxyId, 'Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!result.wasThrown, 'WebKit evaluation threw');
    return result.result.value;
  };
  try {
    await send('Playwright.enable');
    const { browserContextId } = await send('Playwright.createContext');
    await send('Playwright.createPage', { browserContextId });
    for (let wait = 0; !target && wait < 2_000; wait++) await new Promise(resolveWait => setTimeout(resolveWait, 10)); // budget: poll interval, no speed claim.
    assert.ok(target, 'WebKit made a page target');
    await send('Playwright.navigate', { url: ORIGIN, pageProxyId });
    for (let wait = 0; wait < 500; wait++) {
      let value;
      try { value = await evaluate('window.result'); } catch { value = undefined; } // a navigation in flight has no page yet
      if (value) return JSON.parse(value);
      await new Promise(resolveWait => setTimeout(resolveWait, 20)); // budget: poll interval, no speed claim.
    }
    assert.fail('WebKit never left a result on the page');
  } finally {
    try { await send('Playwright.close'); } catch { /* The browser already stopped. */ }
    const stopped = await Promise.race([exited.then(() => true), new Promise(resolveStop => setTimeout(() => resolveStop(false), 3_000))]); // budget: hang ceiling for WebKit shutdown.
    if (!stopped) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The group already exited. */ } await exited; }
    rmSync(profile, { recursive: true, force: true });
  }
}

test('the sealed gzip snapshot decodes through a Response body, the way WebKit accepts [H5,H16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const inputs = snapshotInputs();
  const decoded = Object.fromEntries(inputs.map(input => [input.name, `decoded ${input.length}`]));
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.navigate('about:blank');
  /** Run one decode source on both inputs in Chrome. */
  const inChrome = async (source, options) => JSON.parse(await chrome.evaluate(
    `(() => { ${pageScript(source, inputs, options)}; return new Promise(resolve => { const wait = () => window.result ? resolve(window.result) : setTimeout(wait, 5); wait(); }); })()`, 'decode the sealed snapshots'));
  assert.deepEqual(await inChrome(snapshotDocumentSource()), decoded, 'Chrome opens both sealed gzip snapshots');
  assert.deepEqual(await inChrome(blobStreamSource()), decoded, 'Chrome also decodes the old Blob stream path');
  assert.deepEqual(await inChrome(snapshotDocumentSource(), { blobStreamFails: true }), decoded,
    'the decode does not depend on Blob.stream, which WebKit refuses');

  const webkit = findWebkit();
  if (!webkit) { t.diagnostic('No cached WebKit build on this machine; the WebKit half did not run, the Chrome half did.'); return; }
  const control = await runPageInWebkit(webkit, `<script>${pageScript(blobStreamSource(), inputs)}</script>`);
  for (const input of inputs) {
    assert.match(control[input.name], /^REFUSED \[SNAPSHOT_FORMAT\] The sealed gzip snapshot is invalid/u,
      `the Blob.stream control is no longer red in this WebKit for ${input.name}; this test cannot prove the cure until it is (${control[input.name]})`);
  }
  assert.deepEqual(await runPageInWebkit(webkit, `<script>${pageScript(snapshotDocumentSource(), inputs)}</script>`), decoded,
    'real WebKit opens both sealed gzip snapshots through the shipped decode');
  t.diagnostic('WebKit ran: ' + webkit);
});

/** Publish the later checkpoint with the real API2 CLI writer inside the private fixture. */
async function publishApi2Checkpoint(box, boardId, sequence) {
  const before = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
  assert.equal(before.presentation.state.items.filter(item => item.title.startsWith('PHONE_PENDING_')).length, 3,
    'the local native projection contains all three acknowledged moves before publishing');

  // The actual CLI runs inside relayClientFixture's isolated HOME/PULLBOARD_HOME and publishes through
  // the configured production page writer; it never touches the user's page-cache directory.
  const publishPath = new RegExp(`^/api/v2/boards/${boardId}/uploads/[A-Za-z0-9-]+/publish$`, 'u');
  const publishesBefore = box.calls.filter(call => call.method === 'POST' && publishPath.test(call.path)).length;
  const previousCheckpointMode = box.env.PULLBOARD_RELAY_CHECKPOINT_BACKGROUND;
  // bin/run-tests uses foreground checkpointing; keep this private writer deterministic in direct node --test runs too.
  box.env.PULLBOARD_RELAY_CHECKPOINT_BACKGROUND = '0';
  let published;
  try { published = await box.cli('status'); }
  finally {
    if (previousCheckpointMode === undefined) delete box.env.PULLBOARD_RELAY_CHECKPOINT_BACKGROUND;
    else box.env.PULLBOARD_RELAY_CHECKPOINT_BACKGROUND = previousCheckpointMode;
  }
  assert.equal(published.code, 0, published.document?.error?.message);
  const publishesAfter = box.calls.filter(call => call.method === 'POST' && publishPath.test(call.path)).length;
  assert.ok(publishesAfter > publishesBefore, 'the actual CLI checkpoint publisher writes a new API2 root');

  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(link.snapshotApiVersion, 2, 'the private board used the API2 paged snapshot writer');
  const pageWrites = box.calls.filter(call => call.method === 'PUT'
    && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads\/[A-Za-z0-9-]+\/objects\/[0-9a-f]{64}$/u.test(call.path));
  const publishes = box.calls.filter(call => call.method === 'POST'
    && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads\/[A-Za-z0-9-]+\/publish$/u.test(call.path));
  assert.ok(pageWrites.length > 0 && publishes.length > 0,
    'actual API2 page objects and the root publish reached the private relay');

  const state = await fetch(box.origin + '/api/v2/boards/' + boardId + '/state', {
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(state.status, 200, 'the private relay serves its API2 published head');
  const head = await state.json();
  assert.equal(head.state.apiVersion, 2);
  assert.equal(head.state.sequence, sequence, 'the API2 root covers the exact final move position');
  return head.state;
}

/** Add one genuine sealed move to the private loopback relay and replay its acknowledged receipt locally. */
async function postAndApplyMove(box, link, key, sequence, move) {
  const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(move)), {
    boardId: link.board, kind: 'move', sequence,
  })).toString('base64url');
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/moves', {
    method: 'POST', headers: {
      authorization: 'Bearer ' + link.agentTokens.coordinator.token,
      'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json',
    }, body: JSON.stringify({ sequence, sealed }),
  });
  assert.equal(response.status, 200, 'the private relay accepts the sealed move at its next position');
  const { event } = await response.json();
  assert.equal(event.event_id, sequence);
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    const outcome = applyRelayMove(board, move, {
      sequence, at: event.event_at, sender: event.sender, kind: 'move',
    });
    assert.equal(outcome.error, undefined, 'the acknowledged operation applies through the native engine');
  } finally { closeBoard(board); }
  return event;
}

for (const apiVersion of [1, 2]) test('the phone shows moves past its checkpoint as pending [H5,H16] (API' + apiVersion + ')', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  if (apiVersion === 1) box.legacySnapshotApi(); // Keep explicit historical and current paged wire coverage.
  const initialTitle = 'PHONE_CHECKPOINT_INITIAL_1113';
  const pendingTitles = ['PHONE_PENDING_ONE_1113', 'PHONE_PENDING_TWO_1113', 'PHONE_PENDING_THREE_1113'];
  assert.equal((await box.cliLocal('add', box.lane, initialTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const credential = link.agentTokens.coordinator.token;
  const stateResponse = await fetch(box.origin + '/api/v' + apiVersion + '/boards/' + link.board + '/state', {
    headers: { authorization: 'Bearer ' + credential, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(stateResponse.status, 200, 'the checkpoint at N is present before phone startup');
  const checkpointN = (await stateResponse.json()).state.sequence;

  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  const cookie = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(cookie.success, true);
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('pb.tab','items');window.__relayModuleErrors=[];addEventListener('error',event=>window.__relayModuleErrors.length<8&&window.__relayModuleErrors.push(String(event.message).slice(0,500)));addEventListener('unhandledrejection',event=>window.__relayModuleErrors.length<8&&window.__relayModuleErrors.push(String(event.reason?.message??event.reason).slice(0,500)));" });
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  await press(chrome, "document.querySelector('[data-tab=items]')");
  try { await chrome.waitFor('document.querySelector("[data-pane=items]") && !document.querySelector("[data-pane=items]").hidden && document.querySelector("#chain")?.textContent.includes(' + JSON.stringify(initialTitle) + ')'); }
  catch (error) {
    const state = await chrome.stable('({errors:window.__relayModuleErrors,notice:document.querySelector("#relay-notice")?.textContent,body:document.body.innerText.slice(0,1200)})');
    error.message += '; fixture browser state: ' + JSON.stringify(state);
    throw error;
  }
  const checkpointItems = await chrome.stable(`Array.from(document.querySelectorAll('#chain [data-item]'), row => ({ id: row.dataset.item, title: row.getAttribute('title') }))`);
  assert.ok(checkpointItems.some(item => item.title === initialTitle), 'the initial checkpoint exposes the added item alongside fixture seeds');
  const loadsBefore = box.calls.filter(call => call.method === 'GET' && call.path === '/').length;

  // No native checkpoint is published during this interval. The browser must keep the N projection,
  // while the real stream delivers three sealed events at N+1 through N+3 without a manual state read.
  for (let index = 0; index < pendingTitles.length; index += 1) {
    const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
    let move;
    try {
      // Prepare each operation after replaying its predecessor so the native engine assigns distinct item IDs.
      move = prepareEngineMove(board, 'addItem', [{ by: 'coordinator', lane: box.lane, title: pendingTitles[index] }]);
    } finally { closeBoard(board); }
    await postAndApplyMove(box, link, key, checkpointN + index + 1, move);
  }
  await chrome.waitFor(pendingTitles.map(title => 'document.querySelector("#relay-notice")?.textContent.includes(' + JSON.stringify(title) + ')').join(' && '));
  const pendingView = await chrome.stable(`(() => ({
    items: Array.from(document.querySelectorAll('#chain [data-item]'), row => ({ id: row.dataset.item, title: row.getAttribute('title') })),
    activity: document.querySelector('#relay-notice')?.textContent ?? '',
    pending: Array.from(document.querySelectorAll('#relay-notice p')).filter(row => row.textContent.startsWith('Pending event #')).length,
    body: document.body.innerText,
  }))()`);
  assert.equal(pendingView.pending, 3, 'each received move has its own pending mark');
  assert.doesNotMatch(pendingView.body, /snapshot has not caught up|event prefix is incomplete/iu, 'pending moves are not displayed as a failed board read');
  assert.deepEqual(pendingView.items, checkpointItems, 'the phone keeps checkpoint N authoritative while later events are pending');
  for (const title of pendingTitles) assert.ok(pendingView.activity.includes(title), 'the pending-event notice shows pending event ' + title);
  assert.match(pendingView.body, /pending event/iu, 'the UI identifies the received events as pending rather than checkpoint-derived state');
  assert.equal(box.calls.filter(call => call.method === 'GET' && call.path === '/').length, loadsBefore,
    'the phone catches up without reloading the page');

  const checkpointN3 = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
  assert.equal(checkpointN3.presentation.state.items.filter(item => pendingTitles.includes(item.title)).length, 3,
    'the later native checkpoint includes all three acknowledged operations');
  if (apiVersion === 1) {
    const sealedCheckpoint = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(checkpointN3)), {
      boardId: link.board, kind: 'snapshot', sequence: checkpointN + 3,
    })).toString('base64url');
    const published = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', {
      method: 'PUT', headers: {
        authorization: 'Bearer ' + link.token,
        'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json',
      }, body: JSON.stringify({ sequence: checkpointN + 3, sealed: sealedCheckpoint }),
    });
    assert.equal(published.status, 200, 'the private relay accepts checkpoint N+3');
  } else await publishApi2Checkpoint(box, link.board, checkpointN + 3);
  await chrome.waitFor(pendingTitles.map(title => 'document.querySelector("#chain")?.textContent.includes(' + JSON.stringify(title) + ')').join(' && '));
  const settledView = await chrome.stable(`(() => ({
    items: Array.from(document.querySelectorAll('#chain [data-item]'), row => ({ id: row.dataset.item, title: row.getAttribute('title') })),
    activity: document.querySelector('#relay-notice')?.textContent ?? '',
    pending: Array.from(document.querySelectorAll('#relay-notice p')).filter(row => row.textContent.startsWith('Pending event #')).length,
    body: document.body.innerText,
  }))()`);
  for (const title of pendingTitles) assert.ok(settledView.items.some(row => row.title === title), 'checkpoint N+3 makes ' + title + ' authoritative');
  assert.doesNotMatch(settledView.body, /pending event/iu, 'the pending marks clear once checkpoint N+3 covers the events');
  assert.equal(box.calls.filter(call => call.method === 'GET' && call.path === '/').length, loadsBefore,
    'checkpoint installation keeps the same phone page');
});
