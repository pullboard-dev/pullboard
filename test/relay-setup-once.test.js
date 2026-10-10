/** One real machine setup reaches current and future projects through one phone key [H5,H15,H17]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from './relay-client-fixture.js';
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
function command(root, env, args, timeout = 25_000) {
  const child = spawn(process.execPath, [CLI, ...args, '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const done = new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error('The private setup command exceeded its bounded fixture lifetime.'));
      let document;
      try { document = JSON.parse(stdout); } catch { return reject(new Error('The private setup command did not return JSON.')); }
      resolveResult({ code, document, stderr });
    });
  });
  return { child, done };
}

/** Initialize an independent committed project with origin in place before its registration. */
async function project(box, name) {
  const root = join(dirname(box.root), name);
  mkdirSync(root);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git']]) {
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
  setup = command(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin], 90_000);
  const pending = await waitFor(() => {
    if (!existsSync(machineFile)) return null;
    return JSON.parse(readFileSync(machineFile, 'utf8')).pending;
  }, 'the foreground setup publishes one pending phone enrollment');
  const roots = [box.root, second, third];
  assert.ok(roots.every(root => existsSync(join(root, '.git/pullboard/relay.json'))), 'all three boards linked before first phone enrollment');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 1, 'one GitHub device sign-in covers the entire machine');

  const profileDirectory = join(dirname(box.root), 'phone-profile');
  chrome = await startChrome({ profileDirectory });
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax' })).success, true);
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  const completed = await setup.done;
  assert.equal(completed.code, 0);
  assert.equal(completed.document.linked.length, 3);
  assert.equal(completed.document.paired, true);
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 3");
  assert.equal(await chrome.evaluate('location.hash'), '', 'the one-use secret is stripped from browser history');
  const device = await chrome.evaluate(browserDeviceExpression());
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
  assert.equal(linkProposal.context.target, 'fixture/repository');
  assert.ok(linkProposal.context.expires > Date.now(), 'the proposal carries a visible future expiry');
  assert.equal(typeof linkProposal.sealed, 'string', 'the queued link intent is sealed for the paired phone');
  assert.equal(linkProposal.published, true);
  const approvalPosts = () => box.calls.filter(call => call.method === 'POST' && call.path === '/api/v1/devices/approvals').length;
  assert.equal(approvalPosts(), 1, 'registration publishes one proposal');
  const pendingMessage = 'waiting for phone approval: fourth-project; expires ' + new Date(linkProposal.context.expires).toISOString();
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
  await chrome.waitFor(`document.querySelector(${JSON.stringify(approveLinkButton)}) !== null`);
  const linkCard = await chrome.evaluate(`({text: document.querySelector('.phone-approval[data-request="${linkProposal.context.id}"]').innerText,
    action: document.querySelector(${JSON.stringify(approveLinkButton)}).innerText})`);
  assert.match(linkCard.text, /Link fourth-project\?/u);
  assert.match(linkCard.text, /fixture\/repository/u);
  assert.match(linkCard.text, new RegExp(new Date(linkProposal.context.expires).toISOString().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.equal(linkCard.action, 'Link project', 'the paired phone presents an explicit one-tap link action');
  const approvalsBeforeLinkTap = box.calls.filter(call => call.path.endsWith('/authorize')).length;
  await chrome.evaluate(`document.querySelector(${JSON.stringify(approveLinkButton)}).click()`);
  await chrome.waitFor(`document.querySelector(${JSON.stringify(approveLinkButton)}) === null`);
  assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length, approvalsBeforeLinkTap + 1,
    'one explicit phone tap authorizes the link proposal once');
  const linkedFourth = await command(fourth, box.env, ['status']).done;
  assert.equal(linkedFourth.code, 0);
  assert.equal(link(fourth).account, '7', 'a fresh native status consumes the phone-approved link reply');
  assert.equal(JSON.parse(readFileSync(approvalFile, 'utf8')).approvals.some(entry => entry.root === fourth), false);
  assert.equal(approvalPosts(), 1, 'consuming the phone reply does not submit another proposal');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 1, 'no second machine sign-in');
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 4");
  assert.deepEqual(await chrome.evaluate(browserDeviceExpression()), device, 'a new page retrieves the same private device key');
  await chrome.close();
  rmSync(join(profileDirectory, 'DevToolsActivePort'), { force: true });
  chrome = await startChrome({ profileDirectory });
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax' })).success, true);
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 4");
  assert.deepEqual(await chrome.evaluate(browserDeviceExpression()), device, 'a new browser process retrieves the original non-extractable key');
  for (const root of allRoots) {
    const board = link(root).board;
    assert.equal(await chrome.evaluate(`Object.hasOwn(JSON.parse(localStorage.getItem('pullboard.relay.keys.v1')), ${JSON.stringify(board)})`), true,
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
  assert.deepEqual(await chrome.evaluate(browserDeviceExpression()), device);

  const off = await command(fourth, box.env, ['relay', 'off']).done;
  assert.equal(off.code, 0);
  assert.match(off.document.notice, /Local link removed\. The relay copy stays until you approve deleting it on your phone\./u);
  assert.equal(existsSync(join(fourth, '.git/pullboard/relay.json')), false, 'relay off immediately removes the local link');
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).excluded.includes(fourth), true, 'the local opt-out is durable');
  const deletePost = box.transit.findLast(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals');
  const deleteApproval = JSON.parse(deletePost.request.toString('utf8')).context;
  assert.equal(deleteApproval.action, 'delete-board', 'remote deletion is a separate phone-approved action');
  assert.equal(deleteApproval.target, fourthBoard);
  await chrome.waitFor(`document.querySelector('.phone-approval[data-request="${deleteApproval.id}"]') !== null`);
  const deleteCard = await chrome.evaluate(`({text: document.querySelector('.phone-approval[data-request="${deleteApproval.id}"]').innerText,
    action: document.querySelector('.phone-approval[data-request="${deleteApproval.id}"] button').innerText})`);
  assert.match(deleteCard.text, new RegExp(deleteApproval.target));
  assert.equal(deleteCard.action, 'Delete relay copy');
  const phone = await box.phoneSession();
  const boardsBeforeDeleteTap = await fetch(box.origin + '/auth/boards', { headers: { cookie: 'pb_session=' + phone.token } });
  assert.equal(boardsBeforeDeleteTap.status, 200);
  assert.equal((await boardsBeforeDeleteTap.json()).boards.some(board => board.id === fourthBoard), true,
    'relay off leaves the remote board in place while its phone approval is pending');
  const beforeDeleteTap = box.calls.filter(call => call.path.endsWith('/authorize')).length;
  await chrome.evaluate(`document.querySelector('.phone-approval[data-request="${deleteApproval.id}"] button').click()`);
  await chrome.waitFor(`document.querySelector('.phone-approval[data-request="${deleteApproval.id}"]') === null`);
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
  assert.equal((await command(fourth, box.env, ['relay', 'on', '--url', box.origin]).done).code, 0,
    'explicitly linking the board again requires a foreground sign-in');
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).excluded.includes(fourth), false,
    'explicit board linking clears its opt-out');
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 4");
  assert.deepEqual(await chrome.evaluate(browserDeviceExpression()), device,
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

  const revokeCommand = command(box.root, box.env, ['relay', 'revoke', device.id]);
  t.after(async () => { if (revokeCommand.child.exitCode === null) revokeCommand.child.kill('SIGTERM'); await revokeCommand.done.catch(() => {}); });
  await chrome.waitFor(`[...document.querySelectorAll('.phone-approval')].some(node => node.textContent.includes(${JSON.stringify(device.id)}))`);
  const revocationCard = await chrome.evaluate(`({text: [...document.querySelectorAll('.phone-approval')].find(node => node.textContent.includes(${JSON.stringify(device.id)})).innerText,
    action: [...document.querySelectorAll('.phone-approval')].find(node => node.textContent.includes(${JSON.stringify(device.id)})).querySelector('button').innerText})`);
  assert.match(revocationCard.text, new RegExp(device.id));
  assert.equal(revocationCard.action, 'Approve revocation');
  const beforeRevokeTap = box.calls.filter(call => call.path.endsWith('/authorize')).length;
  await chrome.evaluate(`[...document.querySelectorAll('.phone-approval')].find(node => node.textContent.includes(${JSON.stringify(device.id)})).querySelector('button').click()`);
  const revoked = await revokeCommand.done;
  assert.equal(revoked.code, 0);
  assert.match(revoked.document.notice, /already received remain known/u);
  assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length, beforeRevokeTap + 1,
    'the named-device revocation uses exactly one explicit phone tap');
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).devices.length, 0);
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
  assert.equal(spawnSync('git', ['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: bad, env: box.env }).status, 0);
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
  chrome = await startChrome({ profileDirectory });
  const session = await box.phoneSession();
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: session.token,
    url: box.origin, httpOnly: true, sameSite: 'Lax' })).success, true);
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  const completed = await setup.done;
  assert.equal(completed.code, 0, 'the actual machine setup pairs the phone');
  assert.equal(completed.document.paired, true);
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 1");

  const stretchStarted = Date.now();
  await new Promise(resolve => setTimeout(resolve, 40_100));
  const elapsed = Date.now() - stretchStarted;
  assert.ok(elapsed >= 40_000, 'the fixture waits at least 40 real seconds; it does not advance a frozen relay clock');

  const delayed = await project(box, 'delayed-approval-project');
  const proposal = JSON.parse(readFileSync(machineFile, 'utf8')).approvals.find(entry => entry.root === delayed);
  assert.ok(proposal, 'the later real project registration creates its phone approval');
  const button = '#phone-approve-' + proposal.context.id;
  await assert.doesNotReject(
    chrome.waitFor(`document.querySelector(${JSON.stringify(button)}) !== null`),
    'the elapsed-clock approval becomes a visible card',
  );
  assert.equal(proposal.published, true, 'the relay accepts the native approval after the elapsed delay');
  const card = await chrome.evaluate(`({text: document.querySelector('.phone-approval[data-request="${proposal.context.id}"]').innerText,
    action: document.querySelector(${JSON.stringify(button)}).innerText})`);
  assert.match(card.text, /Link delayed-approval-project\?/u);
  assert.equal(card.action, 'Link project');
  await chrome.evaluate(`document.querySelector(${JSON.stringify(button)}).click()`);
  await chrome.waitFor(`document.querySelector(${JSON.stringify(button)}) === null`);
  const consumed = await command(delayed, box.env, ['status']).done;
  assert.equal(consumed.code, 0, 'the real native follow-up consumes the phone approval');
  assert.equal(existsSync(join(delayed, '.git/pullboard/relay.json')), true);
});
