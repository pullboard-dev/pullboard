/** @pullboard-test-gui */
/** One real machine setup reaches current and future projects through one phone key [H5,H15,H17]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startFixtureChild as spawn, runFixtureChild as spawnSync } from './fixture-child.js';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createPageStepEvaluator } from './chrome-fixture.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { enrollProtocolPhone } from './relay-device-enrollment-fixture.js';
import { startChrome, findChromeExecutable } from './relay-browser-fixture.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Poll a real state change with a finite deadline and no retries of the operation being tested. */
async function waitFor(read, message, timeout = 20_000) {
  const until = Date.now() + timeout;
  do {
    const result = read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < until);
  assert.fail(message);
}

/** Launch the production CLI against an isolated real repository and retain only private diagnostics. */
function command(root, env, args) {
  const child = spawn(process.execPath, [CLI, ...args, '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const done = new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal || code !== 0) {
        const failure = child.fixtureFailure;
        if (signal) return reject(new Error(failure));
      }
      let document;
      try { document = JSON.parse(stdout); } catch { return reject(new Error('The private setup command did not return JSON.')); }
      resolveResult({ code, document, stderr, failure: child.fixtureFailure });
    });
  });
  return { child, done };
}

/** Keep the actual CLI refusal and named protocol stages without dumping private request bodies. */
function setupCommandCapture(result, calls, origin) {
  const stages = calls.map(({ method, path }) => {
    const pathname = new URL(path, origin).pathname;
    const stage = ['/auth/device/start', '/auth/device/poll', '/auth/boards/link', '/auth/machines', '/api/v2', '/api/v1']
      .find(prefix => pathname === prefix || pathname.startsWith(prefix + '/')) ?? 'other';
    return { method, stage };
  }).slice(-32);
  const error = result.document?.error;
  return { exit: result.code, error: error ? { code: error.code, message: error.message } : null, stages };
}

/** Preserve the original success assertion while retaining the refusal that explains a failure. */
function assertSetupSucceeded(result, calls, origin) {
  assert.equal(result.code, 0,
    'explicitly linking the board again requires a foreground sign-in; '
      + JSON.stringify(setupCommandCapture(result, calls, origin)));
}

/** Initialize an independent committed project with origin in place before its registration. */
async function project(box, name) {
  const root = join(dirname(box.root), name);
  mkdirSync(root);
  box.providerState.repositories.push('repository-' + name); // its own repository: one team board per repository [E12]
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', `git@github.com:fixture/repository-${name}.git`]]) {
    assert.equal(spawnSync('git', args, { cwd: root, env: box.env }).status, 0);
  }
  const initialized = await command(root, box.env, ['init']).done;
  assert.equal(initialized.code, 0, 'the additional project registers through the actual init command');
  return root;
}

/** Read one private link without exposing credentials in test diagnostics. */
function link(root) { return JSON.parse(readFileSync(join(root, '.git/pullboard/relay.json'), 'utf8')); }

/** Inspect the actual persisted browser key without exporting its private half. */
function browserDeviceExpression() {
  return `new Promise((resolve, reject) => { const request = indexedDB.open('pullboard-relay-device-v1', 1);
    request.onsuccess = () => { const db=request.result; const transaction=db.transaction('keys'); const read=transaction.objectStore('keys').get('device');
      read.onsuccess = () => { const value=read.result; db.close(); resolve({id:value.deviceId,extractable:value.privateKey.extractable}); }; read.onerror=reject; }; request.onerror=reject; })`;
}

/** Label a set-up-once page wait without changing the existing timeout or expression. */
function pageWait(chrome, step, expression, timeoutMs) {
  return chrome.waitFor(expression, timeoutMs, step);
}

/** Label a set-up-once page evaluation and optionally set its per-command deadline. */
function pageEvaluate(chrome, step, expression, timeoutMs) {
  return chrome.evaluate(expression, step, timeoutMs);
}

test('the set-up-once wait names the step it is on [H5,C7]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  let pendingFetchResponse;
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url?.startsWith('/api/v1/boards/')) {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      pendingFetchResponse = response;
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Capture test</title></head><body>stand-in page</body></html>');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  let chrome;
  t.after(async () => {
    pendingFetchResponse?.end();
    await chrome?.close();
    await new Promise(resolveClose => server.close(resolveClose));
  });
  const address = server.address();
  chrome = await startChrome({
    url: `http://127.0.0.1:${address.port}/stand-in`,
    diagnosticTimeoutMs: 200,
    capturePageSteps: true,
  });
  await pageWait(chrome, 'stand-in document is ready', 'document.readyState === "complete"');
  await pageEvaluate(chrome, 'stand-in device-key step', `Promise.all([
    crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    new Promise((resolve, reject) => { const request = indexedDB.open('page-step-capture-probe', 1);
      request.onsuccess = () => { request.result.close(); resolve(true); }; request.onerror = () => reject(new Error('storage probe failed')); })
  ]).then(() => true)`);
  const pathSentinel = 'unknown-path-sentinel';
  const querySentinel = 'query-sentinel';
  const fragmentSentinel = 'fragment-sentinel';
  const bodySentinel = 'body-sentinel';
  const presentRequestId = '12345678-1234-4234-8234-123456789abc';
  const absentRequestId = '87654321-4321-4321-8321-cba987654321';
  const probeUrl = `/api/v1/boards/${pathSentinel}/state?marker=${querySentinel}#${fragmentSentinel}`;
  await pageEvaluate(chrome, 'start pending privacy probe fetch', `(() => {
    window.__pullboardCaptureProbe = fetch(${JSON.stringify(probeUrl)}, {
      method: 'POST', credentials: 'omit', body: ${JSON.stringify(bodySentinel)}
    }).catch(() => {});
    return true;
  })()`);
  await pageEvaluate(chrome, `install approval card ${presentRequestId}`, `(() => {
    const card = document.createElement('div'); card.className = 'phone-approval'; card.dataset.request = ${JSON.stringify(presentRequestId)};
    card.append(document.createElement('button')); document.body.append(card); return true;
  })()`);
  /** Assert that forced timeout diagnostics contain only the expected stand-in page state. */
  const assertPageCapture = (error, step, approvalCard) => {
    const encoded = /page-step capture: (\{[^\n]+\})/u.exec(error.message)?.[1];
    assert.ok(encoded, 'the timeout carries one bounded page-state record');
    const capture = JSON.parse(encoded);
    assert.equal(capture.stage, step);
    assert.equal(capture.readyState, 'complete');
    assert.match(capture.lastDeviceKeyStep, /crypto\.subtle\.generateKey started/u);
    assert.equal(capture.storageOpenState, 'open');
    assert.equal(capture.pendingFetches.length, 1);
    assert.deepEqual({ method: capture.pendingFetches[0].method, path: capture.pendingFetches[0].path }, {
      method: 'POST', path: '/api/v1/boards/:id/state',
    });
    assert.ok(Number.isFinite(capture.pendingFetches[0].ageMs) && capture.pendingFetches[0].ageMs >= 0);
    assert.deepEqual(capture.approvalCard, approvalCard);
    for (const sentinel of [pathSentinel, querySentinel, fragmentSentinel, bodySentinel]) {
      assert.equal(error.message.includes(sentinel), false, `timeout diagnostics omit ${sentinel}`);
    }
    return true;
  };
  await assert.rejects(pageWait(chrome, `stand-in forced condition step ${presentRequestId}`, 'false', 120), error => assertPageCapture( // budget: 120 ms hang ceiling for forced stand-in timeout capture
    error, `stand-in forced condition step ${presentRequestId}`,
    { requestId: presentRequestId, state: 'present', actionCount: 1 },
  ));
  await assert.rejects(pageWait(chrome, `stand-in absent approval ${absentRequestId}`, 'false', 80), error => assertPageCapture( // budget: 80 ms hang ceiling for forced stand-in timeout capture
    error, `stand-in absent approval ${absentRequestId}`,
    { requestId: absentRequestId, state: 'absent', actionCount: 0 },
  ));
  await assert.rejects(pageWait(chrome, 'stand-in forced condition step', 'false', 80), error => assertPageCapture( // budget: 80 ms hang ceiling for forced stand-in timeout capture
    error, 'stand-in forced condition step', null,
  ));
  await assert.rejects(pageEvaluate(chrome, 'stand-in forced evaluate step', 'new Promise(() => {})', 1_000), error => {
    assert.equal(error.code, 'CDP_TIMEOUT');
    return assertPageCapture(error, 'stand-in forced evaluate step', null);
  });
  const originalTimeout = Object.assign(new Error('DevTools Runtime.evaluate timed out after 17ms.'), { code: 'CDP_TIMEOUT' });
  const unavailableCapture = createPageStepEvaluator(async () => { throw originalTimeout; }, async () => { throw new Error('forced unavailable diagnostic'); });
  await assert.rejects(unavailableCapture('true', 'forced fallback step'), error => {
    assert.strictEqual(error, originalTimeout);
    assert.equal(error.code, 'CDP_TIMEOUT');
    assert.match(error.message, /^DevTools Runtime\.evaluate timed out after 17ms\.; page-step capture unavailable$/u);
    return true;
  });
});

test('set-up-once failure capture retains a real CLI refusal code and message [H5,C7]', async t => {
  const box = await relayClientFixture(t);
  const calls = [];
  const refusal = { code: 'SETUP_CAPTURE_PROBE', message: 'The capture control refused this sign-in; use the fixture relay.' };
  const server = createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    request.resume();
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ version: 1, error: refusal }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await command(box.root, box.env, ['relay', 'on', '--url', origin]).done;
  assert.notEqual(result.code, 0, 'the production CLI actually refuses the loopback protocol response');
  assert.ok(calls.some(call => call.method === 'POST' && call.path === '/auth/device/start'),
    'the refusal crosses the actual foreground sign-in protocol');
  assert.equal(result.document.error.code, refusal.code);
  assert.ok(result.document.error.message.includes(refusal.message));
  const capture = setupCommandCapture(result, calls, origin);
  assert.deepEqual(capture.error, result.document.error && {
    code: result.document.error.code, message: result.document.error.message,
  }, 'capture retains the CLI document code and complete message, not only its exit status');
  assert.throws(() => assertSetupSucceeded(result, calls, origin), error => {
    assert.ok(error.message.includes(JSON.stringify(capture)), 'the same failing assertion reports the retained refusal');
    return true;
  });
});

test('set up once links three registered boards, later registration and a persistent phone without another pairing [H5,H15,H17]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  let chrome;
  let setup;
  t.after(async () => {
    await chrome?.close();
    if (setup?.child.exitCode === null) setup.child.kill('SIGTERM');
    await setup?.done.catch(() => {});
  });
  const box = await relayClientFixture(t);
  const second = await project(box, 'second-project');
  const third = await project(box, 'third-project');
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  setup = command(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin]);
  const pending = await waitFor(() => {
    if (!existsSync(machineFile)) return null;
    return JSON.parse(readFileSync(machineFile, 'utf8')).pending;
  }, 'the foreground setup publishes one pending phone enrollment');
  const roots = [box.root, second, third];
  assert.ok(roots.every(root => existsSync(join(root, '.git/pullboard/relay.json'))), 'all three boards linked before first phone enrollment');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 1, 'one GitHub device sign-in covers the entire machine');

  const profileDirectory = join(dirname(box.root), 'phone-profile');
  chrome = await startChrome({ profileDirectory, capturePageSteps: true });
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax' })).success, true);
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  const completed = await setup.done;
  assert.equal(completed.code, 0);
  assert.equal(completed.document.linked.length, 3);
  assert.equal(completed.document.paired, true);
  await pageWait(chrome, 'initial pairing renders registered boards', "document.querySelectorAll('#proj-list .proj.repo').length === 3");
  // Rows precede address settlement; the initial Items view may deliberately retain an empty fragment.
  await pageWait(chrome, 'initial pairing settles the board address', `(() => {
    const state = history.state;
    const parts = location.hash.slice(1).split('/');
    const addressed = parts.length <= 2 && parts.at(-1) === state?.tab && parts.every(part => part && !part.includes('='));
    return typeof state?.root === 'string' && state.detail === null && ['home', 'items'].includes(state.tab)
      && document.querySelector('.tab.on')?.dataset.tab === state.tab
      && (addressed || state.tab === 'items' && location.hash === '');
  })()`);
  const settled = await pageEvaluate(chrome, 'initial pairing reads its settled place', "({tab: history.state.tab, emptyFragment: location.hash === ''})");
  t.diagnostic(`initial pairing settled on ${settled.tab}, empty fragment: ${settled.emptyFragment}`);
  const pairedUrl = await pageEvaluate(chrome, 'initial pairing reads the settled address', 'location.href');
  const navigation = await chrome.send('Page.getNavigationHistory');
  assert.ok(navigation.entries.length > 0, 'the actual browser history is inspected');
  for (const url of [pairedUrl, ...navigation.entries.map(entry => entry.url)]) {
    assert.equal(url.includes('device='), false, 'the one-use pairing fragment is absent from the address and history');
    assert.equal(url.includes(pending.locator), false, 'the pairing locator is absent from the address and history');
    assert.equal(url.includes(pending.secret), false, 'the one-use secret is absent from the address and history');
  }
  const device = await pageEvaluate(chrome, 'initial pairing reads the persisted device key', browserDeviceExpression());
  assert.equal(device.extractable, false, 'the private phone key is persisted non-extractable in IndexedDB');
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).devices[0].deviceId, device.id);
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).pending, null);

  const fourth = await project(box, 'fourth-project');
  const allRoots = [...roots, fourth];
  const approvalFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const waitingState = JSON.parse(readFileSync(approvalFile, 'utf8'));
  const linkProposal = waitingState.approvals.find(entry => entry.root === fourth);
  assert.ok(linkProposal, 'the fourth project stays local with one persisted phone-link proposal');
  const fourthBoard = linkProposal.context.board;
  assert.equal(existsSync(join(fourth, '.git/pullboard/relay.json')), false, 'registration does not grant itself a board credential');
  assert.equal(linkProposal.context.action, 'link');
  assert.equal(linkProposal.context.target, 'fixture/repository-fourth-project');
  assert.ok(linkProposal.context.expires > Date.now(), 'the proposal carries a visible future expiry');
  assert.equal(typeof linkProposal.sealed, 'string', 'the queued link intent is sealed for the paired phone');
  assert.equal(linkProposal.published, true);
  const approvalPosts = () => box.calls.filter(call => call.method === 'POST' && call.path === '/api/v1/devices/approvals').length;
  assert.equal(approvalPosts(), 1, 'registration publishes one proposal');
  const pendingMessage = 'waiting for phone approval: approve linking fourth-project on Phone browser by '
    + new Date(linkProposal.context.expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const statusPending = await command(fourth, box.env, ['status']).done;
  assert.equal(statusPending.code, 0, 'status remains available while a new board awaits phone approval');
  const doctor = await command(fourth, box.env, ['doctor']).done;
  assert.equal(doctor.document.problems.some(problem => problem.message === pendingMessage), true);
  const resumedPending = await command(fourth, box.env, ['resume']).done;
  assert.equal(resumedPending.document.relayProblems.some(problem => problem.message === pendingMessage), true);
  const repeatedPending = JSON.parse(readFileSync(approvalFile, 'utf8')).approvals.find(entry => entry.root === fourth);
  assert.equal(repeatedPending.context.id, linkProposal.context.id, 'read-only status and diagnosis keep the same proposal');
  assert.equal(approvalPosts(), 1, 'status and doctor do not replace or duplicate the request');
  await chrome.navigate(box.origin);
  const approveLinkButton = '#phone-approve-' + linkProposal.context.id;
  await pageWait(chrome, `link approval card ${linkProposal.context.id}`, `document.querySelector(${JSON.stringify(approveLinkButton)}) !== null`);
  const linkCard = await pageEvaluate(chrome, `read link approval card ${linkProposal.context.id}`, `({text: document.querySelector('.phone-approval[data-request="${linkProposal.context.id}"]').innerText,
    action: document.querySelector(${JSON.stringify(approveLinkButton)}).innerText})`);
  assert.match(linkCard.text, /Link fourth-project from /u, 'the link card names the board and the computer asking');
  assert.match(linkCard.text, /fixture\/repository/u);
  assert.match(linkCard.text, /expires /u, 'the proposal shows its expiry');
  assert.equal(linkCard.text.includes(new Date(linkProposal.context.expires).toISOString()), false, 'the expiry is in the phone\'s local time');
  assert.equal(linkCard.action, 'Link project', 'the paired phone presents an explicit one-tap link action');
  const approvalsBeforeLinkTap = box.calls.filter(call => call.path.endsWith('/authorize')).length;
  await pageEvaluate(chrome, `tap link approval ${linkProposal.context.id}`, `document.querySelector(${JSON.stringify(approveLinkButton)}).click()`);
  await pageWait(chrome, `link approval completes ${linkProposal.context.id}`, `document.querySelector(${JSON.stringify(approveLinkButton)}) === null`);
  assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length, approvalsBeforeLinkTap + 1,
    'one explicit phone tap authorizes the link proposal once');
  const linkedFourth = await command(fourth, box.env, ['status']).done;
  assert.equal(linkedFourth.code, 0);
  assert.equal(link(fourth).account, '7', 'a fresh native status consumes the phone-approved link reply');
  assert.equal(JSON.parse(readFileSync(approvalFile, 'utf8')).approvals.some(entry => entry.root === fourth), false);
  assert.equal(approvalPosts(), 1, 'consuming the phone reply does not submit another proposal');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 1, 'no second machine sign-in');
  await pageWait(chrome, 'fourth board appears after approval', "document.querySelectorAll('#proj-list .proj.repo').length === 4");
  assert.deepEqual(await pageEvaluate(chrome, 'new page retrieves the paired device key', browserDeviceExpression()), device, 'a new page retrieves the same private device key');
  await chrome.close();
  rmSync(join(profileDirectory, 'DevToolsActivePort'), { force: true });
  chrome = await startChrome({ profileDirectory, capturePageSteps: true });
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax' })).success, true);
  await chrome.navigate(box.origin);
  await pageWait(chrome, 'reopened browser renders linked boards', "document.querySelectorAll('#proj-list .proj.repo').length === 4");
  assert.deepEqual(await pageEvaluate(chrome, 'reopened browser retrieves the paired device key', browserDeviceExpression()), device, 'a new browser process retrieves the original non-extractable key');
  for (const root of allRoots) {
    const board = link(root).board;
    assert.equal(await pageEvaluate(chrome, 'reopened browser loads a linked board key', `Object.hasOwn(JSON.parse(localStorage.getItem('pullboard.relay.keys.v1')), ${JSON.stringify(board)})`), true,
      'the actual browser unwrapped each board key, including the later board');
  }

  // Explicit --all always signs in again, while retaining the paired phone key and avoiding re-pairing.
  const resumed = await command(box.root, box.env, ['relay', 'on', '--all']).done;
  assert.equal(resumed.code, 0);
  assert.equal(resumed.document.linked.length, 4);
  assert.equal(resumed.document.paired, true);
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 2, 'explicit relay on --all performs a fresh foreground sign-in');
  assert.equal(box.calls.filter(call => call.method === 'POST' && call.path.startsWith('/api/v1/devices/enrollments/')).length, 1,
    'the existing paired phone is retained without another pairing enrollment');
  assert.deepEqual(await pageEvaluate(chrome, 'explicit setup retains the paired device key', browserDeviceExpression()), device);

  const off = await command(fourth, box.env, ['relay', 'off']).done;
  assert.equal(off.code, 0);
  assert.match(off.document.notice, /Local link removed\. The relay copy stays until you approve deleting it on your phone\./u);
  assert.equal(existsSync(join(fourth, '.git/pullboard/relay.json')), false, 'relay off immediately removes the local link');
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).excluded.includes(fourth), true, 'the local opt-out is durable');
  const deletePost = box.transit.findLast(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals');
  const deleteApproval = JSON.parse(deletePost.request.toString('utf8')).context;
  assert.equal(deleteApproval.action, 'delete-board', 'remote deletion is a separate phone-approved action');
  assert.equal(deleteApproval.target, fourthBoard);
  await pageWait(chrome, `delete approval card ${deleteApproval.id}`, `document.querySelector('.phone-approval[data-request="${deleteApproval.id}"]') !== null`);
  const deleteCard = await pageEvaluate(chrome, `read delete approval card ${deleteApproval.id}`, `({text: document.querySelector('.phone-approval[data-request="${deleteApproval.id}"]').innerText,
    action: document.querySelector('.phone-approval[data-request="${deleteApproval.id}"] button').innerText})`);
  assert.match(deleteCard.text, /Delete fourth-project from the relay\?/u, 'the delete card names the board');
  assert.equal(deleteCard.action, 'Delete relay copy');
  const phone = await box.phoneSession();
  const boardsBeforeDeleteTap = await fetch(box.origin + '/auth/boards', { headers: { cookie: 'pb_session=' + phone.token } });
  assert.equal(boardsBeforeDeleteTap.status, 200);
  assert.equal((await boardsBeforeDeleteTap.json()).boards.some(board => board.id === fourthBoard), true,
    'relay off leaves the remote board in place while its phone approval is pending');
  const beforeDeleteTap = box.calls.filter(call => call.path.endsWith('/authorize')).length;
  await pageEvaluate(chrome, `tap delete approval ${deleteApproval.id}`, `document.querySelector('.phone-approval[data-request="${deleteApproval.id}"] button').click()`);
  await pageWait(chrome, `delete approval completes ${deleteApproval.id}`, `document.querySelector('.phone-approval[data-request="${deleteApproval.id}"]') === null`);
  assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length, beforeDeleteTap + 1,
    'the remote copy is deleted only after the deliberate phone tap');
  const boardsAfterDeleteTap = await fetch(box.origin + '/auth/boards', { headers: { cookie: 'pb_session=' + phone.token } });
  assert.equal(boardsAfterDeleteTap.status, 200);
  assert.equal((await boardsAfterDeleteTap.json()).boards.some(board => board.id === fourthBoard), false,
    'the explicit phone approval removes the relay copy before relinking');

  assert.equal((await command(fourth, box.env, ['init']).done).code, 0);
  assert.equal(existsSync(join(fourth, '.git/pullboard/relay.json')), false, 'registration respects the explicit local opt-out');
  const excludedSetup = await command(box.root, box.env, ['relay', 'on', '--all']).done;
  assert.equal(excludedSetup.code, 0);
  assert.equal(excludedSetup.document.linked.length, 3, 'explicit machine setup does not undo the fourth-board opt-out');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 3,
    'each explicit relay on --all performs a fresh foreground sign-in');
  assert.equal(box.calls.filter(call => call.method === 'POST' && call.path.startsWith('/api/v1/devices/enrollments/')).length, 1,
    'the paired phone is not enrolled again while excluding a board');
  const relinkCallsStart = box.calls.length;
  const relinked = await command(fourth, box.env, ['relay', 'on', '--url', box.origin]).done;
  assertSetupSucceeded(relinked, box.calls.slice(relinkCallsStart), box.origin);
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).excluded.includes(fourth), false,
    'explicit board linking clears its opt-out');
  await pageWait(chrome, 'relinking renders four linked boards', "document.querySelectorAll('#proj-list .proj.repo').length === 4");
  assert.deepEqual(await pageEvaluate(chrome, 'relinking retains the paired device key', browserDeviceExpression()), device,
    'relinking wraps the board for the same paired phone key');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 4);
  assert.equal(box.calls.filter(call => call.method === 'POST' && call.path.startsWith('/api/v1/devices/enrollments/')).length, 1);

  const publicBytes = Buffer.concat(box.transit.flatMap(record => [record.request, record.response]));
  const durableBytes = readFileSync(join(box.relayDirectory, 'devices.sqlite'));
  assert.equal(publicBytes.includes(pending.secret), false, 'the pairing secret never reaches the relay');
  for (const root of allRoots) {
    const raw = readFileSync(join(box.env.PULLBOARD_HOME, 'relay-keys', link(root).board + '.key'), 'utf8').trim();
    assert.equal(publicBytes.includes(raw), false, 'no clear board key in actual relay traffic');
    assert.equal(durableBytes.includes(raw), false, 'no clear board key in relay device records');
    assert.equal(durableBytes.includes(Buffer.from(raw, 'base64url')), false, 'no raw board-key bytes in relay records');
  }

  const revokedDeviceId = await enrollProtocolPhone(box);
  const approvalsBeforeRevoke = box.transit.filter(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals').length;
  const revokeCommand = command(box.root, box.env, ['relay', 'revoke', revokedDeviceId]);
  t.after(async () => { if (revokeCommand.child.exitCode === null) revokeCommand.child.kill('SIGTERM'); await revokeCommand.done.catch(() => {}); });
  /** Read the request id for the newly published revocation without adding another wait. */
  const revokeRequestId = () => {
    const approvals = box.transit.filter(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals');
    const post = approvals.length > approvalsBeforeRevoke ? approvals.at(-1) : null;
    return post ? JSON.parse(post.request.toString('utf8')).context.id : 'request pending';
  };
  await pageWait(chrome, () => `device revocation approval ${revokeRequestId()}`, `[...document.querySelectorAll('.phone-approval')].some(node => node.textContent.includes(${JSON.stringify(revokedDeviceId)}))`);
  const revokeId = revokeRequestId();
  const revocationCard = await pageEvaluate(chrome, `read device revocation approval ${revokeId}`, `({text: [...document.querySelectorAll('.phone-approval')].find(node => node.textContent.includes(${JSON.stringify(revokedDeviceId)})).innerText,
    action: [...document.querySelectorAll('.phone-approval')].find(node => node.textContent.includes(${JSON.stringify(revokedDeviceId)})).querySelector('button').innerText})`);
  assert.match(revocationCard.text, new RegExp(revokedDeviceId));
  assert.equal(revocationCard.action, 'Approve revocation');
  const beforeRevokeTap = box.calls.filter(call => call.path.endsWith('/authorize')).length;
  await pageEvaluate(chrome, `tap device revocation approval ${revokeId}`, `[...document.querySelectorAll('.phone-approval')].find(node => node.textContent.includes(${JSON.stringify(revokedDeviceId)})).querySelector('button').click()`);
  const revoked = await revokeCommand.done;
  assert.equal(revoked.code, 0);
  assert.match(revoked.document.notice, /already received remain known/u);
  assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length, beforeRevokeTap + 1,
    'the named-device revocation uses exactly one explicit phone tap');
  assert.deepEqual(JSON.parse(readFileSync(machineFile, 'utf8')).devices.map(entry => entry.deviceId), [device.id], 'the approving phone remains paired; only the other target is removed');
});


test('set up once keeps completed links on interruption and names partial failures [H5,H17]', async t => {
  const box = await relayClientFixture(t);
  const bad = await project(box, 'invalid-origin-project');
  assert.equal(spawnSync('git', ['remote', 'set-url', 'origin', 'https://invalid.example/repository.git'], { cwd: bad, env: box.env }).status, 0);
  const file = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const started = command(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin]);
  t.after(async () => { if (started.child.exitCode === null) started.child.kill('SIGTERM'); await started.done.catch(() => {}); });
  await waitFor(() => box.calls.some(call => call.method === 'GET' && call.path.startsWith('/api/v1/devices/enrollments/')),
    'first pairing is waiting in the foreground');
  started.child.kill('SIGINT');
  const partial = await started.done;
  assert.equal(partial.code, 1, 'a named project failure produces a nonzero status even when the other board linked');
  assert.equal(partial.document.linked.length, 1);
  assert.equal(partial.document.failed[0].root, bad);
  assert.match(partial.document.failed[0].reason, /GitHub/u);
  assert.equal(partial.document.paired, false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pending, null, 'interruption leaves no half device enrollment');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).devices.length, 0);
  const retained = link(box.root).board;
  assert.equal(spawnSync('git', ['remote', 'set-url', 'origin', 'git@github.com:fixture/repository-invalid-origin-project.git'], { cwd: bad, env: box.env }).status, 0);
  const before = box.calls.length;
  const retry = command(box.root, box.env, ['relay', 'on', '--all']);
  t.after(async () => { if (retry.child.exitCode === null) retry.child.kill('SIGTERM'); await retry.done.catch(() => {}); });
  await waitFor(() => box.calls.slice(before).some(call => call.method === 'GET' && call.path.startsWith('/api/v1/devices/enrollments/')),
    'a later process can obtain a fresh pairing link without repeating sign-in');
  retry.child.kill('SIGINT');
  const completed = await retry.done;
  assert.equal(completed.code, 0, 'successful links exit zero even when phone pairing was interrupted');
  assert.equal(completed.document.linked.length, 2);
  assert.equal(link(box.root).board, retained, 'rerunning setup keeps the existing board and key');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 2,
    'retrying explicit relay on --all signs in again before starting a fresh pairing');
});

test('set up once reports a newly registered project when its stored session is gone [H5,H17]', async t => {
  const box = await relayClientFixture(t);
  const machine = new URL('../src/relay-machine.js', import.meta.url).href;
  const saved = await box.script(`import { updateRelayMachine } from ${JSON.stringify(machine)};
    updateRelayMachine(state => {state.autoLink=true;state.session=null;}); console.log(JSON.stringify({saved:true}));`);
  assert.equal(saved.code, 0);
  const unlinked = await project(box, 'needs-signin-project');
  assert.equal(existsSync(join(unlinked, '.git/pullboard/relay.json')), false);
  const message = 'not linked: needs-signin-project; run pullboard relay on --all';
  const doctor = await command(unlinked, box.env, ['doctor']).done;
  assert.equal(doctor.document.problems.some(problem => problem.message === message), true);
  const resume = await command(unlinked, box.env, ['resume']).done;
  assert.equal(resume.document.relayProblems.some(problem => problem.message === message), true);
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 0, 'registration never silently starts another GitHub sign-in');
});

test('a set-up-once run stretched past 30 seconds still gets its approval card [H5,C7]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  let chrome;
  let setup;
  t.after(async () => {
    await chrome?.close();
    if (setup?.child.exitCode === null) setup.child.kill('SIGTERM');
    await setup?.done.catch(() => {});
  });

  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  setup = command(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin], 90_000);
  const pending = await waitFor(() => {
    if (!existsSync(machineFile)) return null;
    return JSON.parse(readFileSync(machineFile, 'utf8')).pending;
  }, 'set-up-once publishes a real pending phone enrollment');
  const profileDirectory = join(dirname(box.root), 'stretched-approval-phone-profile');
  chrome = await startChrome({ profileDirectory, capturePageSteps: true });
  const session = await box.phoneSession();
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: session.token,
    url: box.origin, httpOnly: true, sameSite: 'Lax' })).success, true);
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  const completed = await setup.done;
  assert.equal(completed.code, 0, 'the actual machine setup pairs the phone');
  assert.equal(completed.document.paired, true);
  await pageWait(chrome, 'initial pairing renders the registered board', "document.querySelectorAll('#proj-list .proj.repo').length === 1");

  const stretchStarted = Date.now();
  await new Promise(resolve => setTimeout(resolve, 40_100));
  const elapsed = Date.now() - stretchStarted;
  assert.ok(elapsed >= 40_000, 'the fixture waits at least 40 real seconds; it does not advance a frozen relay clock'); // budget: declared 40100ms fixture sleep must span at least 40 real seconds.

  const delayed = await project(box, 'delayed-approval-project');
  const proposal = JSON.parse(readFileSync(machineFile, 'utf8')).approvals.find(entry => entry.root === delayed);
  assert.ok(proposal, 'the later real project registration creates its phone approval');
  const button = '#phone-approve-' + proposal.context.id;
  await assert.doesNotReject(
    pageWait(chrome, `delayed project approval card ${proposal.context.id}`, `document.querySelector(${JSON.stringify(button)}) !== null`),
    'the elapsed-clock approval becomes a visible card',
  );
  assert.equal(proposal.published, true, 'the relay accepts the native approval after the elapsed delay');
  const card = await pageEvaluate(chrome, `read delayed project approval card ${proposal.context.id}`, `({text: document.querySelector('.phone-approval[data-request="${proposal.context.id}"]').innerText,
    action: document.querySelector(${JSON.stringify(button)}).innerText})`);
  assert.match(card.text, /Link delayed-approval-project from /u);
  assert.equal(card.action, 'Link project');
  await pageEvaluate(chrome, `tap delayed project approval ${proposal.context.id}`, `document.querySelector(${JSON.stringify(button)}).click()`);
  await pageWait(chrome, `delayed project approval completes ${proposal.context.id}`, `document.querySelector(${JSON.stringify(button)}) === null`);
  const consumed = await command(delayed, box.env, ['status']).done;
  assert.equal(consumed.code, 0, 'the real native follow-up consumes the phone approval');
  assert.equal(existsSync(join(delayed, '.git/pullboard/relay.json')), true);
});
